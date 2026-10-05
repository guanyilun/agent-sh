# Template run file: agent-sh run campaign.py [--help | --dry-run | --target "..."]
from dataclasses import dataclass

from agentsh import budget, log, map, run

description = "Plan, fan out, collect; repeat until the planner says it's done."

args = dict(
    target=dict(default="the problem in README.md", help="what to work on"),
    rounds=dict(default=5, help="maximum planning rounds"),
)

config = dict(
    agents="./agents",
    concurrency=6,
    maxRuns=200,
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
        if budget.remaining() < 200_000:
            break
        # The planner's only memory is the notes it's handed each round.
        plan = await run(None, f"""
            Plan round {round} for {args.target}. Notes so far:
            {notes or "(none)"}
        """, returns=Plan)
        if plan.done:
            return f"Done after {round - 1} round(s).\n{notes}"

        results = [r for r in await map(plan.tasks, lambda task: run(None, f"{task}\nWrite outputs only under ./out.")) if r]
        notes += f"\n## Round {round}\n" + "\n---\n".join(results)
        log(f"round {round}: {len(results)}/{len(plan.tasks)} tasks finished")
    return f"Stopped (round or budget limit).\n{notes}"
