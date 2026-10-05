"""Workflow API for agent-sh run files written in Python; see WORKFLOWS.md ("Python")."""
import asyncio
import builtins
import contextvars
import dataclasses
import inspect
import json
import os
import threading
import typing

__all__ = ["run", "map", "pipeline", "race", "agent", "log", "budget", "Won", "RunError", "WorkflowStop"]


class RunError(Exception):
    """A subagent run failed."""


class WorkflowStop(Exception):
    """The whole workflow is ending (budget, run cap, deadline, Ctrl-C); map, pipeline and race re-raise it."""


class Won(typing.NamedTuple):
    value: typing.Any
    index: int


class _Scope:
    def __init__(self, path=""):
        self.path, self.next = path, 0

    def take(self):
        self.next += 1
        return self.next


_scope = contextvars.ContextVar("agentsh_scope")


class _Channel:
    def __init__(self, read_fd, write_fd):
        self._in = os.fdopen(read_fd, "r", encoding="utf-8")
        self._out = os.fdopen(write_fd, "w", encoding="utf-8")
        self._lock = threading.Lock()
        self._pending = {}
        self._rid = 0
        self.loop = None
        self.usage = {"total": None, "spent": 0}

    def send(self, message):
        with self._lock:
            self._out.write(json.dumps(message, default=_plain) + "\n")
            self._out.flush()

    def read(self):
        line = self._in.readline()
        return json.loads(line) if line else None

    def call(self, kind, **fields):
        self._rid += 1
        future = self.loop.create_future()
        self._pending[self._rid] = future
        self.send({"t": kind, "rid": self._rid, **fields})
        return future

    def listen(self, loop):
        self.loop = loop
        threading.Thread(target=self._pump, daemon=True).start()

    def _pump(self):
        while True:
            try:
                message = self.read()
            except Exception:  # noqa: BLE001
                message = None
            self.loop.call_soon_threadsafe(self._deliver, message)
            if message is None:
                return

    def _deliver(self, message):
        if message is None:
            for future in self._pending.values():
                if not future.done():
                    future.set_exception(WorkflowStop("agent-sh went away"))
            self._pending.clear()
            return
        if "budget" in message:
            self.usage = message["budget"]
        future = self._pending.pop(message.get("rid"), None)
        if future is None or future.done():
            return
        if message.get("ok"):
            future.set_result(message.get("value"))
        elif message.get("cancelled"):
            future.cancel()
        else:
            future.set_exception((WorkflowStop if message.get("stop") else RunError)(message.get("error", "failed")))


_chan = None


def _plain(value):
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        return dataclasses.asdict(value)
    return str(value)


def _is_model(tp):
    return isinstance(tp, type) and dataclasses.is_dataclass(tp)


def _optional(tp):
    args = typing.get_args(tp)
    if typing.get_origin(tp) is typing.Union or type(tp).__name__ == "UnionType":
        rest = [a for a in args if a is not type(None)]
        if len(rest) < len(args):
            return rest[0] if len(rest) == 1 else typing.Union[tuple(rest)]
    return None


def _schema(tp):
    inner = _optional(tp)
    if inner is not None:
        return _schema(inner)
    if _is_model(tp):
        hints = typing.get_type_hints(tp)
        fields = dataclasses.fields(tp)
        required = [f.name for f in fields if _optional(hints[f.name]) is None
                    and f.default is dataclasses.MISSING and f.default_factory is dataclasses.MISSING]
        return {"type": "object", "properties": {f.name: _schema(hints[f.name]) for f in fields}, "required": required}
    origin = typing.get_origin(tp)
    if origin in (list, tuple, set):
        args = typing.get_args(tp)
        return {"type": "array", "items": _schema(args[0])} if args else {"type": "array"}
    if origin is typing.Literal:
        return {"enum": list(typing.get_args(tp))}
    if tp is bool:
        return {"type": "boolean"}
    if tp is int:
        return {"type": "integer"}
    if tp is float:
        return {"type": "number"}
    if tp is str:
        return {"type": "string"}
    if tp in (list, tuple, set):
        return {"type": "array"}
    return {"type": "object"} if tp is dict or origin is dict else {}


def _decode(tp, value):
    inner = _optional(tp)
    if inner is not None:
        return None if value is None else _decode(inner, value)
    if _is_model(tp) and isinstance(value, dict):
        hints = typing.get_type_hints(tp)
        return tp(**{f.name: _decode(hints[f.name], value[f.name]) for f in dataclasses.fields(tp) if f.name in value})
    if typing.get_origin(tp) is list and isinstance(value, list) and typing.get_args(tp):
        return [_decode(typing.get_args(tp)[0], v) for v in value]
    return value


def _typed(returns):
    """A dataclass (or list[dataclass]) becomes JSON Schema; shorthand and JSON Schema pass through."""
    if _is_model(returns) or typing.get_origin(returns) is list:
        return _schema(returns), returns
    return returns, None


async def _settle(value):
    return await value if inspect.isawaitable(value) else value


def _start(spec, run_id, at, session=None, model=None):
    future = _chan.call("run", id=run_id, scope=at.path, spec=spec, **({"session": session} if session else {}))
    if model is None:
        return future

    async def decoded():
        return _decode(model, await future)
    return asyncio.ensure_future(decoded())


def _spec(agent, task, options):
    unknown = set(options) - {"returns", "tools", "system", "model", "thinking", "label"}
    if unknown:
        raise TypeError(f"run() got unexpected option(s): {', '.join(sorted(unknown))}")
    schema, model = _typed(options.get("returns"))
    spec = {k: v for k, v in options.items() if v is not None and k != "returns"}
    spec.update(agent=agent, task=str(task))
    if schema is not None:
        spec["returns"] = schema
    return spec, model


def run(agent, task, **options):
    """Start a subagent now and return an awaitable for its answer: text, or data shaped like `returns`."""
    at = _scope.get()
    spec, model = _spec(agent, task, options)
    return _start(spec, f"{at.path}{at.take()}", at, model=model)


class _Agent:
    def __init__(self, name, options):
        self._name, self._options = name, options
        self._id = f"{_scope.get().path}{_scope.get().take()}"
        self._turns, self._last = 0, None

    def ask(self, task, **options):
        """The next turn of the same conversation; turns run one at a time."""
        at = _scope.get()
        spec, model = _spec(self._name, task, {**self._options, **options})
        self._turns += 1
        turn_id, previous = f"{self._id}:{self._turns}", self._last

        async def turn():
            if previous is not None:
                await asyncio.wait([previous])
            return await _start(spec, turn_id, at, session=self._id, model=model)
        self._last = asyncio.ensure_future(turn())
        return self._last


def agent(name=None, **options):
    """An agent that keeps its conversation between ask() calls; options apply to every turn."""
    return _Agent(name, options)


async def _in_item(path, work):
    token = _scope.set(_Scope(path))
    try:
        return await work()
    finally:
        _scope.reset(token)


async def map(items, fn):  # noqa: A001 - mirrors the JavaScript API
    """fn(item) for every item concurrently, results in order; a failed item becomes None."""
    items = list(items)
    at = _scope.get()
    k = at.take()

    async def one(i):
        try:
            return await _in_item(f"{at.path}{k}.{i}/", lambda: _settle(fn(items[i])))
        except WorkflowStop:
            raise
        except Exception as err:  # noqa: BLE001
            log(f"map item {i + 1} failed: {err}")
            return None
    return await _all([one(i) for i in range(len(items))])


async def pipeline(items, *stages):
    """Each item goes through stage(previous, item) on its own; an item whose stage fails becomes None."""
    items = list(items)
    at = _scope.get()
    k = at.take()

    async def one(i):
        async def through():
            value = items[i]
            for n, stage in enumerate(stages):
                try:
                    value = await _settle(stage(value, items[i]))
                except WorkflowStop:
                    raise
                except Exception as err:  # noqa: BLE001
                    log(f"pipeline item {i + 1} failed at stage {n + 1}: {err}")
                    return None
            return value
        return await _in_item(f"{at.path}{k}.{i}/", through)
    return await _all([one(i) for i in range(len(items))])


async def _all(coroutines):
    tasks = [asyncio.ensure_future(c) for c in coroutines]
    try:
        return list(await asyncio.gather(*tasks))
    except BaseException:
        for t in tasks:
            t.cancel()
        raise


async def race(items, fn, accept=None):
    """The first fn(item) result that accept(value) passes wins and the rest are cancelled; None if none does."""
    items = list(items)
    at = _scope.get()
    k = at.take()
    race_id, key = f"{at.path}{k}", f"race:{len(items)}"
    path = lambda i: f"{at.path}{k}.{i}/"  # noqa: E731

    async def attempt(i):
        async def work():
            value = await _settle(fn(items[i]))
            return value, accept is None or bool(await _settle(accept(value)))
        return await _in_item(path(i), work)

    def failed(i, err):
        if isinstance(err, WorkflowStop):
            raise err
        log(f"race item {i + 1} failed: {err}")

    # On resume only the recorded winner runs; if it no longer passes, the others race.
    tried = await _chan.call("race_get", id=race_id, key=key, scope=at.path)
    if tried is not None and tried < len(items):
        try:
            value, ok = await attempt(tried)
            if ok:
                await _chan.call("race_set", id=race_id, key=key, winner=tried)
                return Won(value, tried)
        except Exception as err:  # noqa: BLE001
            failed(tried, err)
    else:
        tried = None

    tasks = {asyncio.ensure_future(attempt(i)): i for i in range(len(items)) if i != tried}
    won = None
    waiting = set(tasks)
    try:
        while waiting and won is None:
            done, waiting = await asyncio.wait(waiting, return_when=asyncio.FIRST_COMPLETED)
            for t in sorted(done, key=tasks.get):
                if t.cancelled():
                    continue
                if t.exception() is not None:
                    failed(tasks[t], t.exception())
                elif t.result()[1] and won is None:
                    won = Won(t.result()[0], tasks[t])
    finally:
        if waiting:
            for t in waiting:
                t.cancel()
            # Replies once the losers' subagents have really stopped.
            await _chan.call("cancel", scopes=[path(tasks[t]) for t in waiting])
            await asyncio.wait(waiting)
    if won is not None:
        await _chan.call("race_set", id=race_id, key=key, winner=won.index)
    return won


def log(message):
    """A progress line."""
    _chan.send({"t": "log", "message": str(message)})


class _Budget:
    """Subagent tokens, as of the latest finished run."""

    @property
    def total(self):
        return _chan.usage.get("total")

    def spent(self):
        return _chan.usage.get("spent", 0)

    def remaining(self):
        return float("inf") if self.total is None else builtins.max(0, self.total - self.spent())


budget = _Budget()


class _Args(dict):
    __getattr__ = dict.__getitem__


def _serve(module, read_fd, write_fd):
    global _chan
    _chan = _Channel(read_fd, write_fd)
    main = getattr(module, "main", None)
    if not inspect.iscoroutinefunction(main):
        _chan.send({"t": "hello", "error": "the file must define `async def main()`"})
        return 1
    _chan.send({"t": "hello", "args": getattr(module, "args", None), "description": getattr(module, "description", "")})
    start = _chan.read()
    if not start or start.get("t") != "start":
        return 0
    _chan.usage = start.get("budget", _chan.usage)
    given = start.get("args")
    given = _Args(given) if isinstance(given, dict) else given

    async def go():
        _chan.listen(asyncio.get_running_loop())
        _scope.set(_Scope())
        return await (main(given) if inspect.signature(main).parameters else main())
    try:
        result = asyncio.run(go())
    except BaseException as err:  # noqa: BLE001
        import traceback
        stop = isinstance(err, (WorkflowStop, KeyboardInterrupt, asyncio.CancelledError))
        detail = "" if isinstance(err, (WorkflowStop, RunError)) else traceback.format_exc()
        _chan.send({"t": "fail", "error": str(err) or type(err).__name__, "stop": stop, "traceback": detail})
        return 1
    _chan.send({"t": "done", "result": result})
    return 0
