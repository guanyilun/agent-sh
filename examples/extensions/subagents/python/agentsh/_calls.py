"""The calls a workflow makes: run, Agent, race and step."""
import asyncio
import hashlib
import inspect
import json

from . import _host, _shapes
from ._positions import Position, here, start


def run(task, *, agent=None, returns=None, tools=None, system=None, model=None, thinking=None, label=None):
    """Give `task` to an agent and get its answer.

    The agent starts working straight away, and the call returns an awaitable for the answer, so
    several can run at once:

        first, second = await asyncio.gather(run("..."), run("..."))

    agent     a named agent ("explore", "reviewer", "worker", ...); leave it out for a plain one
    returns   a dataclass, and the answer comes back as an instance of it instead of as text
    tools     the tools a plain agent may use ([] for none)
    system    a plain agent's role and rules
    model, thinking, label   override the agent's model, its reasoning effort, and its name in progress lines

    A run that fails raises RunError.
    """
    position = here()
    spec = _spec(task, agent, returns, tools=tools, system=system, model=model, thinking=thinking, label=label)
    return _answer(spec, position.next(), position, returns)


class Agent:
    """An agent you keep talking to: every `ask` continues the same conversation.

        worker = Agent("worker")
        draft = await worker.ask("Write the function described in SPEC.md.")
        final = await worker.ask(f"The tests fail:\\n{output}\\nFix it.")

    The options are the same as for `run` and apply to every turn.
    """

    def __init__(self, name=None, *, tools=None, system=None, model=None, thinking=None, label=None):
        self._name = name
        self._options = dict(tools=tools, system=system, model=model, thinking=thinking, label=label)
        self._id = here().next()
        self._turns = 0
        self._last_turn = None

    def ask(self, task, *, returns=None, model=None, thinking=None, label=None):
        """Say `task` to the agent and get its answer. Turns happen one at a time, in the order asked."""
        position = here()
        overrides = {name: value for name, value in dict(model=model, thinking=thinking, label=label).items() if value is not None}
        spec = _spec(task, self._name, returns, **{**self._options, **overrides})
        self._turns += 1
        turn_id, previous = f"{self._id}:{self._turns}", self._last_turn

        async def turn():
            if previous is not None:
                await asyncio.wait([previous])
            return await _answer(spec, turn_id, position, returns, conversation=self._id)

        self._last_turn = start(turn(), position)
        return self._last_turn


async def race(*attempts, accept=None):
    """Try several things at once; return the first result that is good enough and cancel the rest.

        proof = await race(prove(lemma, "by induction"), prove(lemma, "by contradiction"),
                           accept=lambda proof: proof.complete)

    Each attempt is an awaitable: a `run(...)`, or a call to one of your own async functions.
    `accept` decides whether a result is good enough (any result that isn't None, if left out).
    Returns None when every attempt finished and none was accepted.
    """
    link = _host.link()
    position = here()
    race_id = position.next()
    kind = f"race:{len(attempts)}"

    async def judged(attempt):
        result = await attempt
        if accept is None:
            return result, result is not None
        verdict = accept(result)
        return result, bool(await verdict if inspect.isawaitable(verdict) else verdict)

    def begin(index):
        return start(judged(attempts[index]), Position(f"{race_id}.{index}/"))

    def report_failure(index, error):
        link.send("log", message=f"race: attempt {index + 1} failed: {error}")

    # A resumed run already knows who won: run only that attempt again.
    remaining = list(range(len(attempts)))
    winner = await link.request("race_get", id=race_id, key=kind, scope=position.path)
    if winner is not None and winner < len(attempts):
        remaining.remove(winner)
        try:
            result, accepted = await begin(winner)
        except Exception as error:  # noqa: BLE001
            report_failure(winner, error)
            accepted = False
        if accepted:
            for index in remaining:
                _discard(attempts[index])
            await _finish_race(link, race_id, kind, winner)
            return result

    running = {begin(index): index for index in remaining}
    unfinished = set(running)
    winner, result = None, None
    try:
        while unfinished and winner is None:
            finished, unfinished = await asyncio.wait(unfinished, return_when=asyncio.FIRST_COMPLETED)
            for task in sorted(finished, key=running.get):
                if task.cancelled():
                    continue
                if task.exception() is not None:
                    report_failure(running[task], task.exception())
                elif task.result()[1] and winner is None:
                    winner, result = running[task], task.result()[0]
    finally:
        for task in unfinished:
            task.cancel()
        if unfinished:
            await asyncio.wait(unfinished)
    await _finish_race(link, race_id, kind, winner)
    return result if winner is not None else None


async def step(function, *args, **kwargs):
    """Do a piece of the program's own work once per run.

        passed, output = await step(run_tests, directory)

    This calls `run_tests(directory)` and records the result next to the agents' answers. When an
    interrupted run is resumed, the recorded result is handed back and the function is not called
    again. Use it for work that is slow, or that would not give the same result a second time.

    `function` may be async or not. Its result must be plain data (numbers, text, lists, dicts);
    a tuple comes back as a list.
    """
    link = _host.link()
    position = here()
    step_id = position.next()
    called_with = json.dumps([function.__qualname__, args, kwargs], default=str, sort_keys=True)
    kind = "step:" + hashlib.sha256(called_with.encode()).hexdigest()[:16]

    recorded = await link.request("step_get", id=step_id, key=kind, scope=position.path, name=function.__name__)
    if recorded["found"]:
        return recorded["value"]

    async def call():
        result = function(*args, **kwargs)
        return await result if inspect.isawaitable(result) else result

    # Below its own position, so whatever the function does can't shift the numbering of the calls after it.
    result = await start(call(), Position(step_id + "/"))
    result = json.loads(json.dumps(result, default=_shapes.plain))
    await link.request("step_set", id=step_id, key=kind, value=result)
    return result


async def _finish_race(link, race_id, kind, winner):
    # Wait until the cancelled agents have really stopped, so nothing is still writing when the program moves on.
    await link.request("quiet")
    if winner is not None:
        await link.request("race_set", id=race_id, key=kind, winner=winner)


def _discard(attempt):
    """Drop an attempt that will not be needed."""
    if inspect.iscoroutine(attempt):
        attempt.close()
    elif hasattr(attempt, "cancel"):
        attempt.cancel()


def _spec(task, agent, returns, **options):
    spec = {name: value for name, value in options.items() if value is not None}
    spec.update(agent=agent, task=str(task))
    if returns is not None:
        spec["returns"] = _shapes.schema(returns) if _shapes.is_shape(returns) else returns
    return spec


def _answer(spec, call_id, position, returns, conversation=None):
    extra = {"session": conversation} if conversation else {}
    reply = _host.link().request("run", id=call_id, scope=position.path, spec=spec, **extra)
    if not _shapes.is_shape(returns):
        return reply

    async def shaped():
        return _shapes.build(returns, await reply)

    return start(shaped(), position)
