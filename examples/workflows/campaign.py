"""A template to start from: plan, do the planned tasks at the same time, repeat until the planner says it's done.

    agent-sh run campaign.py --target "the problem in README.md"
    agent-sh run campaign.py --help        the arguments below
    agent-sh run campaign.py --dry-run     walk through it without calling a model
"""
import asyncio
from dataclasses import dataclass

from agentsh import budget, run

description = "Plan, fan out, collect; repeat until the planner says it's done."

# Command-line arguments; main() receives them as args.target and args.rounds.
args = dict(
    target=dict(default="the problem in README.md", help="what to work on"),
    rounds=dict(default=5, help="maximum planning rounds"),
)

# Limits for the whole run, enforced by agent-sh.
config = dict(
    agents="./agents",        # extra agent definitions, next to this file
    concurrency=6,            # agents working at once
    maxRuns=200,              # agent runs in total
    budgetTokens=5_000_000,
    hours=3,
)


@dataclass
class Plan:
    done: bool
    tasks: list[str]


async def main(args):
    notes = ""
    for round in range(1, args.rounds + 1):
        if budget.remaining < 200_000:
            break

        # The planner remembers nothing between rounds except the notes it is handed.
        plan = await run(f"""
            Plan round {round} for {args.target}. Notes so far:
            {notes or "(none)"}
        """, returns=Plan)
        if plan.done:
            return f"Done after {round - 1} round(s).\n{notes}"

        # One agent per task, all at once. A task whose agent fails comes back as an exception.
        answers = await asyncio.gather(
            *[run(f"{task}\nWrite outputs only under ./out.") for task in plan.tasks],
            return_exceptions=True)
        finished = [answer for answer in answers if isinstance(answer, str)]

        notes += f"\n## Round {round}\n" + "\n---\n".join(finished)
        print(f"round {round}: {len(finished)}/{len(plan.tasks)} tasks finished")
    return f"Stopped (round or budget limit).\n{notes}"
