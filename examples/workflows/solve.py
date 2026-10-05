# Split a goal into tasks and solve each against a check command the agents can't talk their way past:
#   agent-sh run solve.py --goal "implement the functions listed in SPEC.md" --check "python -m pytest -q {dir}"
# Each attempt gets its own directory, so add `sandbox=dict(write=["./out"])` (sandbox extension) to hold agents to it.
import asyncio
import os
import re
import shlex
from dataclasses import dataclass

from agentsh import agent, budget, log, map, pipeline, race, run

description = "Split a goal into tasks; per task, race approaches, repair against a check command, then let skeptics review what passed"

args = dict(
    goal=dict(required=True, help="what to get done"),
    check=dict(required=True, help="shell command that exits 0 when an attempt is good; {dir} is the attempt's directory"),
    approaches=dict(default=2, help="approaches to race per task (up to 3)"),
    repairs=dict(default=3, help="times an agent may fix a failed check"),
    out=dict(default="./out", help="where attempts are written"),
)

config = dict(concurrency=6, maxRuns=300, budgetTokens=10_000_000, hours=4)

APPROACHES = [
    "the most direct way",
    "start from the edge cases and work inwards",
    "the simplest thing that could pass, then tighten it",
]
ANGLES = [
    "Does it do what the task asks, or only what the check happens to test?",
    "What input or case would break it?",
    "Is anything hard-coded, stubbed or skipped to get past the check?",
]
CHECK_SECONDS = 600
RESERVE = 300_000  # tokens: below this, stop repairing and report what there is


@dataclass
class Task:
    name: str
    goal: str


@dataclass
class Plan:
    tasks: list[Task]


@dataclass
class Solution:
    summary: str
    files: list[str]


@dataclass
class Verdict:
    refuted: bool
    reason: str


@dataclass
class Attempt:
    approach: str
    dir: str
    solution: Solution
    passed: bool
    repairs: int


@dataclass
class Result:
    attempt: Attempt
    sound: bool
    objections: list[str]


async def check(command, directory):
    """Pass or fail is the command's exit code, never an agent's word."""
    proc = await asyncio.create_subprocess_shell(
        command.replace("{dir}", shlex.quote(directory)),
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
    try:
        output, _ = await asyncio.wait_for(proc.communicate(), CHECK_SECONDS)
        return proc.returncode == 0, output.decode(errors="replace")[-4000:]
    except asyncio.TimeoutError:
        return False, f"the check did not finish within {CHECK_SECONDS}s"
    finally:
        if proc.returncode is None:  # timed out, or this attempt lost the race
            proc.kill()


async def attempt(task, n, approach, args):
    directory = os.path.abspath(os.path.join(args.out, re.sub(r"[^\w.-]+", "-", task.name), str(n + 1)))
    os.makedirs(directory, exist_ok=True)
    worker = agent("worker", label=f"{task.name}#{n + 1}")
    solution = await worker.ask(f"""
        {task.goal}
        Approach: {approach}.
        Work only inside {directory}. You are done when this command passes: {args.check}
    """, returns=Solution)
    for repairs in range(args.repairs + 1):
        passed, output = await check(args.check, directory)
        if passed or repairs == args.repairs or budget.remaining() < RESERVE:
            return Attempt(approach, directory, solution, passed, repairs)
        # The same agent again: it still knows what it tried and why.
        solution = await worker.ask(f"The check failed. Fix it.\n\n{output}", returns=Solution)


async def main(args):
    plan = await run("plan", f"""
        Split this goal into tasks that can each be done and checked on their own, in separate directories:
        {args.goal}
        Give each a short name that works as a directory name.
    """, returns=Plan)
    tasks = plan.tasks
    log(f"{len(tasks)} task(s): {', '.join(t.name for t in tasks)}")

    async def solve(task, _):
        approaches = list(enumerate(APPROACHES[:args.approaches]))
        won = await race(approaches, lambda a: attempt(task, a[0], a[1], args), accept=lambda found: found.passed)
        if won is None:
            raise RuntimeError("no approach passed the check")
        log(f"{task.name}: approach {won.index + 1} passed after {won.value.repairs} repair(s)")
        return won.value

    async def review(found, task):
        votes = [v for v in await map(ANGLES, lambda angle: run("reviewer", f"""
            A check command passed for this work, which is not the same as the work being right. Try to refute it.
            Task: {task.goal}
            Files: {found.dir}
            The author's summary: {found.solution.summary}
            {angle}
            Answer refuted=true only for a concrete problem you can point to in the files.
        """, returns=Verdict)) if v]
        objections = [v.reason for v in votes if v.refuted]
        # A skeptic that failed doesn't count in the work's favour.
        return Result(found, (len(votes) - len(objections)) * 2 > len(ANGLES), objections)

    # Each task moves on to review as soon as it's solved, without waiting for the others.
    results = await pipeline(tasks, solve, review)

    lines = []
    for task, result in zip(tasks, results):
        if result is None:
            lines.append(f"- {task.name}: NOT SOLVED (no approach passed the check, or the run failed)")
        elif result.sound:
            lines.append(f"- {task.name}: solved in {result.attempt.dir}")
        else:
            lines.append(f"- {task.name}: passes the check but reviewers object, see {result.attempt.dir}")
            lines += [f"    - {o}" for o in result.objections]
    solved = sum(1 for r in results if r and r.sound)
    return f"{solved}/{len(tasks)} task(s) solved and reviewed.\n" + "\n".join(lines)
