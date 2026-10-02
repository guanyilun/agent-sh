import type { Workflow } from "../workflow-types.js";

export const description = "Review in parallel (correctness, tests), fix the findings, repeat until clean";

export const args = {
  target: { default: "the uncommitted changes (`git diff HEAD`)", help: "what to review" },
  rounds: { default: 3, help: "maximum review-and-fix rounds" },
};

const REVIEW = { verdict: "clean | issues", findings: "string[]" };

export default (async ({ run, map, args, log }) => {
  let findings: string[] = [];

  for (let round = 1; round <= args.rounds; round++) {
    const reviews = await map(["correctness bugs", "missing or weak tests"], (focus) =>
      run("reviewer", `Review ${args.target}, focusing only on ${focus}.`, { returns: REVIEW }));

    // A failed reviewer comes back null; it never counts as clean.
    const done = reviews.filter(Boolean);
    if (!done.length) throw new Error("every reviewer failed");
    findings = done.flatMap((r) => r.findings);
    if (done.length === reviews.length && done.every((r) => r.verdict === "clean")) {
      return `Clean after ${round} round(s).`;
    }
    if (round === args.rounds) break;

    log(`round ${round}: ${findings.length} finding(s), fixing`);
    await run("worker", `
      Fix only these review findings in ${args.target}; change nothing else:
      - ${findings.join("\n- ")}
    `);
  }
  return `Stopped after ${args.rounds} rounds. Remaining findings:\n- ${findings.join("\n- ")}`;
}) satisfies Workflow;
