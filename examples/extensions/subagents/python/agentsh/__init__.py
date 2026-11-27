"""Write agent-sh workflows in Python.

A workflow is an ordinary asyncio program. `run` gives a task to an agent and
returns its answer; loops, branching and running things at the same time are
plain Python.

    import asyncio
    from agentsh import run

    async def main():
        summary, risks = await asyncio.gather(
            run("Summarise CHANGES.md in five lines."),
            run("List the riskiest changes in CHANGES.md.", agent="reviewer"),
        )
        return f"{summary}\\n\\n{risks}"

Start it with `agent-sh run file.py`. agent-sh runs the agents, records every
finished call so an interrupted run can be resumed, and enforces the limits
the file sets in `config`.

    run          give one task to an agent
    Agent        an agent you keep talking to, turn after turn
    race         try several things at once and keep the first good result
    checkpoint   mark a function of your own whose results a resumed run should not redo
    event        record what the program decided or measured, for reading the run afterwards
    budget       how many tokens are left
"""
from ._calls import Agent, checkpoint, event, race, run
from ._host import RunCut, RunError, budget, run_id

__all__ = ["run", "Agent", "race", "checkpoint", "event", "budget", "run_id", "RunError", "RunCut"]
