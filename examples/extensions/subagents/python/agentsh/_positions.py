"""Numbers every agent call by where it sits in the program.

When an interrupted run is resumed, the program starts again from the top and
agent-sh hands back the answers it already has. To match a call to its old
answer it needs a name for the call that is the same in both runs.

The name is a position. Each asyncio task counts its own steps: its first
call is "1", its next "2". A task started by another task uses up one of its
parent's steps and counts below it, so "3/1" is the first call made by the
task that was its parent's third step. The same program, given the same
answers, makes the same calls at the same positions, whichever of its
concurrent tasks happens to finish first.
"""
import asyncio
import contextvars


class Position:
    """Where a task is in the program, and a counter for its next step."""

    def __init__(self, path=""):
        self.path = path
        self._steps = 0

    def next(self):
        self._steps += 1
        return f"{self.path}{self._steps}"


_current = contextvars.ContextVar("agentsh_position")


def here():
    """The position of the task that is running now."""
    return _current.get()


async def _from(position, awaitable):
    _current.set(position)
    return await awaitable


def start(awaitable, position):
    """Start `awaitable` as a task that counts its steps from `position`."""
    return asyncio.Task(_from(position, awaitable), loop=asyncio.get_running_loop())


def number_tasks(loop):
    """Give every task the program starts from now on a position of its own."""
    _current.set(Position())

    def new_task(loop, coroutine, **options):
        parent = _current.get(None)
        if parent is None:
            return asyncio.Task(coroutine, loop=loop, **options)
        return asyncio.Task(_from(Position(parent.next() + "/"), coroutine), loop=loop, **options)

    loop.set_task_factory(new_task)
