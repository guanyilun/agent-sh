import type { Workflow } from "../workflow-types.js";

export const description = "Review a result from several angles in parallel, fix the findings, repeat until clean";

export const args = {
  target: { default: "the uncommitted changes (`git diff HEAD`)", help: "what to review: changes, a file, a document, an analysis" },
  focus: { default: "correctness, completeness", help: "comma-separated angles, one reviewer each" },
  rounds: { default: 3, help: "maximum review-and-fix rounds" },
};

const REVIEW = { verdict: "clean | issues", findings: "string[]" };

export default (async ({ run, map, args, log }) => {
  const focuses = String(args.focus).split(",").map((f) => f.trim()).filter(Boolean);
  let findings: string[] = [];

  for (let round = 1; round <= args.rounds; round++) {
    const reviews = await map(focuses, (focus) =>
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
