"""Get a goal done as separate tasks, each proven by a command instead of by an agent's say-so.

    agent-sh run solve.py --goal "implement the functions listed in SPEC.md" \\
                          --check "python -m pytest -q {dir}"

What happens:

    1. A planner splits the goal into tasks.
    2. Every task is worked on at the same time. For one task:
         a. Two agents try it in different ways, each in its own directory.
         b. After each try, this script runs the check command there. If it fails,
            the output goes back to the same agent, which tries again.
         c. The first try that passes wins, and the other agent is stopped.
         d. Three reviewers then try to find something wrong with the winner.
    3. The report says which tasks are solved, which pass but are disputed, and which failed.
"""
import asyncio
import os
import re
import shlex
from dataclasses import dataclass

from agentsh import Agent, budget, checkpoint, race, run

description = "Split a goal into tasks; for each, race two approaches against a check command, then have reviewers attack what passed"

args = dict(
    goal=dict(required=True, help="what to get done"),
    check=dict(required=True, help="shell command that exits 0 when a try is good; {dir} is the try's directory"),
    repairs=dict(default=3, help="how many times an agent may fix a failed check"),
    out=dict(default="./out", help="where the work is written"),
)

config = dict(concurrency=6, maxRuns=300, budgetTokens=10_000_000, hours=4)

APPROACHES = [
    "Take the most direct route.",
    "Start from the edge cases and work inwards.",
]
OBJECTIONS = [
    "Does it do what the task asks, or only what the check happens to test?",
    "What input or case would break it?",
    "Is anything hard-coded, stubbed or skipped to get past the check?",
]
CHECK_TIMEOUT = 600        # seconds
TOKENS_TO_KEEP = 300_000   # stop repairing below this, so the run can still finish and report


@dataclass
class Task:
    name: str
    goal: str


@dataclass
class Plan:
    tasks: list[Task]


@dataclass
class Summary:
    """What an agent says it did."""
    summary: str
    files: list[str]


@dataclass
class Verdict:
    """One reviewer's opinion of a solution."""
    refuted: bool
    reason: str


@dataclass
class Try:
    """One agent's go at one task."""
    directory: str
    summary: str
    passed: bool
    repairs: int


@dataclass
class Outcome:
    """How one task ended, and its lines of the report."""
    solved: bool
    report: str


async def main(args):
    plan = await run(f"""
        Split this goal into tasks that can each be done and checked on their own, in separate directories:
        {args.goal}
        Give each task a short name that works as a directory name.
    """, agent="plan", returns=Plan)
    print(f"{len(plan.tasks)} task(s): {', '.join(task.name for task in plan.tasks)}")

    # All tasks at once. If the work on a task raises, gather hands back the exception in its place.
    outcomes = await asyncio.gather(*[solve(task, args) for task in plan.tasks], return_exceptions=True)
    outcomes = [outcome if isinstance(outcome, Outcome) else Outcome(False, f"- {task.name}: FAILED ({outcome})")
                for task, outcome in zip(plan.tasks, outcomes)]

    solved = sum(outcome.solved for outcome in outcomes)
    return f"{solved}/{len(outcomes)} task(s) solved.\n" + "\n".join(outcome.report for outcome in outcomes)


async def solve(task, args):
    """One task from start to finish."""
    base = os.path.abspath(os.path.join(args.out, re.sub(r"[^\w.-]+", "-", task.name)))
    tries = [attempt(task, approach, os.path.join(base, str(number)), args)
             for number, approach in enumerate(APPROACHES, start=1)]

    winner = await race(*tries, accept=lambda this_try: this_try.passed)
    if winner is None:
        return Outcome(False, f"- {task.name}: NOT SOLVED (no try passed the check)")
    print(f"{task.name}: passed after {winner.repairs} repair(s)")

    objections = await review(task, winner)
    if objections:
        listed = "".join(f"\n    - {objection}" for objection in objections)
        return Outcome(False, f"- {task.name}: passes the check, but reviewers object ({winner.directory}){listed}")
    return Outcome(True, f"- {task.name}: solved ({winner.directory})")


async def attempt(task, approach, directory, args):
    """One agent works on the task in its own directory until the check passes or it runs out of repairs."""
    os.makedirs(directory, exist_ok=True)
    worker = Agent("worker", label=task.name)
    said = await worker.ask(f"""
        {task.goal}
        {approach}
        Work only inside {directory}. You are done when this command passes: {args.check}
    """, returns=Summary)

    for repairs in range(args.repairs + 1):
        passed, output = await check(args.check, directory)
        out_of_room = repairs == args.repairs or budget.remaining < TOKENS_TO_KEEP
        if passed or out_of_room:
            return Try(directory, said.summary, passed, repairs)
        # Ask the same agent, so it still remembers what it tried and why.
        said = await worker.ask(f"The check failed. Fix it.\n\n{output}", returns=Summary)


@checkpoint   # a resumed run gets the saved result instead of running the check again
async def check(command, directory):
    """Run the check command. Whether a try is good is its exit code, never an agent's word."""
    process = await asyncio.create_subprocess_shell(
        command.replace("{dir}", shlex.quote(directory)),
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
    try:
        output, _ = await asyncio.wait_for(process.communicate(), CHECK_TIMEOUT)
        return process.returncode == 0, output.decode(errors="replace")[-4000:]
    except asyncio.TimeoutError:
        return False, f"The check did not finish within {CHECK_TIMEOUT} seconds."
    finally:
        if process.returncode is None:   # timed out, or this try lost the race
            process.kill()


async def review(task, winner):
    """Three reviewers each try to refute the winning try. Returns their objections; none means the work stands."""
    def ask_reviewer(question):
        return run(f"""
            A check command passed for this work. That is not the same as the work being right: try to refute it.
            Task: {task.goal}
            Files: {winner.directory}
            The author's summary: {winner.summary}
            {question}
            Answer refuted=true only for a concrete problem you can point to in the files.
        """, agent="reviewer", returns=Verdict)

    def objection_in(answer):
        if not isinstance(answer, Verdict):
            return f"a reviewer failed: {answer}"   # no answer counts against the work
        return answer.reason if answer.refuted else None

    answers = await asyncio.gather(*[ask_reviewer(question) for question in OBJECTIONS], return_exceptions=True)
    objections = [objection for objection in map(objection_in, answers) if objection]

    # The work stands only if most of the reviewers could not fault it.
    accepted = len(OBJECTIONS) - len(objections)
    return [] if accepted > len(OBJECTIONS) / 2 else objections
