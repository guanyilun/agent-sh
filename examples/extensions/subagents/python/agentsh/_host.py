"""The connection to agent-sh, which runs the agents on this program's behalf.

agent-sh starts this program and talks to it over a pipe, one JSON object per
line. The program sends requests ("run this task"); agent-sh sends each reply
when the work is done.
"""
import asyncio
import inspect
import json
import os
import threading
import traceback
import types

from . import _positions, _shapes


class RunError(Exception):
    """An agent's run failed: the model or a tool gave an error, or the answer never fitted the shape asked for."""


class Connection:
    def __init__(self, read_fd, write_fd):
        self._incoming = os.fdopen(read_fd, "r", encoding="utf-8")
        self._outgoing = os.fdopen(write_fd, "w", encoding="utf-8")
        self._write_lock = threading.Lock()
        self._waiting = {}  # request number -> the future its reply will complete
        self._requests = 0
        self._loop = None
        self._stop_program = None
        self.stopped = None  # why agent-sh is ending the run, once it is
        self.tokens = {"total": None, "spent": 0}

    def send(self, kind, **fields):
        with self._write_lock:
            self._outgoing.write(json.dumps({"t": kind, **fields}, default=_shapes.plain) + "\n")
            self._outgoing.flush()

    def receive(self):
        """Wait for the next message; None once agent-sh has gone."""
        line = self._incoming.readline()
        return json.loads(line) if line else None

    def request(self, kind, **fields):
        """Send a request and return a future for its reply. Cancelling the future abandons the request."""
        self._requests += 1
        number = self._requests
        reply = self._loop.create_future()
        self._waiting[number] = reply
        reply.add_done_callback(lambda _: self._abandon(number))
        self.send(kind, rid=number, **fields)
        return reply

    def _abandon(self, number):
        # Still waiting means the program gave up on it, so the agent should stop too.
        if self._waiting.pop(number, None) is not None:
            self.send("abandon", rid=number)

    def listen(self, loop, stop_program):
        """Deliver replies on the event loop from now on."""
        self._loop, self._stop_program = loop, stop_program
        threading.Thread(target=self._read_replies, daemon=True).start()

    def _read_replies(self):
        while True:
            try:
                message = self.receive()
            except (OSError, ValueError):
                message = None
            self._loop.call_soon_threadsafe(self._deliver, message)
            if message is None:
                return

    def _deliver(self, message):
        if message is None:
            return self._stop("agent-sh went away")
        self.tokens = message.get("budget", self.tokens)
        reply = self._waiting.pop(message.get("rid"), None)
        if reply is None or reply.done():
            return
        if message.get("ok"):
            reply.set_result(message.get("value"))
        elif message.get("stop"):
            reply.cancel()
            self._stop(message.get("error"))
        elif message.get("cancelled"):
            reply.cancel()
        else:
            reply.set_exception(RunError(message.get("error", "the run failed")))

    def _stop(self, reason):
        """agent-sh is ending the run (budget, deadline, Ctrl-C): cancel the program, as asyncio would."""
        if self.stopped is None:
            self.stopped = reason or "stopped"
            self._stop_program()


_link = None


def link():
    if _link is None:
        raise RuntimeError("agentsh only works in a file started with `agent-sh run`")
    return _link


class Budget:
    """Tokens the agents have used, as of the last call that finished.

    `total` is None unless the run has a token budget (`budgetTokens` in the file's config).
    """

    @property
    def total(self):
        return link().tokens.get("total")

    @property
    def spent(self):
        return link().tokens.get("spent", 0)

    @property
    def remaining(self):
        return float("inf") if self.total is None else max(0, self.total - self.spent)


budget = Budget()


def serve(module, read_fd, write_fd):
    """Run the file's `main` and report how it went. Returns the exit code."""
    global _link
    _link = Connection(read_fd, write_fd)
    main = getattr(module, "main", None)
    if not inspect.iscoroutinefunction(main):
        _link.send("hello", error="the file must define `async def main()`")
        return 1
    _link.send("hello", args=getattr(module, "args", None), description=getattr(module, "description", ""))

    start = _link.receive()
    if not start or start.get("t") != "start":
        return 0
    _link.tokens = start.get("budget", _link.tokens)
    given = start.get("args")
    if isinstance(given, dict):
        given = types.SimpleNamespace(**given)

    async def program():
        loop = asyncio.get_running_loop()
        _link.listen(loop, stop_program=asyncio.current_task().cancel)
        _positions.number_tasks(loop)
        return await (main(given) if inspect.signature(main).parameters else main())

    try:
        result = asyncio.run(program())
    except asyncio.CancelledError:
        _link.send("fail", error=_link.stopped or "cancelled", stop=True)
        return 1
    except Exception as error:  # noqa: BLE001 - whatever the file raised is the run's failure
        detail = "" if isinstance(error, RunError) else traceback.format_exc()
        _link.send("fail", error=str(error) or type(error).__name__, traceback=detail)
        return 1
    _link.send("done", result=result)
    return 0
