// Template: a whole unattended campaign in one file.
//   agent-sh run campaign.ts --target "the problem in README.md"     (needs the subagents extension)
//   agent-sh run campaign.ts --help                                  (lists the arguments below)
//   agent-sh run campaign.ts --dry-run                               (no model calls: checks the flow)
// On a cluster, a job script reduces to:  module load node-js/22; agent-sh run campaign.ts --target ...
import type { Workflow } from "agent-sh-subagents";

export const description = "Plan, fan out, collect; repeat until the planner says it's done.";

export const args = {
  target: { default: "the problem in README.md", help: "what to work on" },
  rounds: { default: 5, help: "maximum planning rounds" },
};

export const config = {
  agents: "./agents",                 // your role prompts (*.md), next to this file
  concurrency: 6,
  maxRuns: 200,
  budgetTokens: 5_000_000,
  hours: 3,
  sandbox: { write: ["./out"], os: "preferred" },
};

export default (async ({ run, map, args, log, budget }) => {
  let notes = "";
  for (let round = 1; round <= args.rounds && budget.remaining() > 200_000; round++) {
    // The "master" is just a typed run in a loop; its memory is the notes it carries forward (or files in ./out).
    const plan = await run(null, `
      Plan round ${round} for ${args.target}. Notes so far:
      ${notes || "(none)"}
    `, { returns: { done: "boolean", tasks: "string[]" } });
    if (plan.done) return `Done after ${round - 1} round(s).\n${notes}`;

    const results = (await map(plan.tasks, (task: string) => run(null, `${task}\nWrite outputs only under ./out.`))).filter(Boolean);
    notes += `\n## Round ${round}\n${results.join("\n---\n")}`;
    log(`round ${round}: ${results.length}/${plan.tasks.length} tasks finished`);
  }
  return `Stopped (round or budget limit).\n${notes}`;
}) satisfies Workflow;
