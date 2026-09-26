import type { Workflow } from "../workflow-types.js";

export const description = "Review in parallel (correctness, tests), fix the findings, repeat until clean; max 3 rounds";

const FOCUSES = ["correctness bugs", "missing or weak tests"];
const MAX_ROUNDS = 3;

export default (async ({ run, all, args, log }) => {
  const target = args || "the uncommitted changes (`git diff HEAD`)";
  let findings: string[] = [];

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const reviews = await all(FOCUSES.map(focus => ({
      agent: "reviewer",
      task: `Review ${target}, focusing only on ${focus}.`,
      schema: {
        verdict: { enum: ["clean", "issues"] },
        findings: { type: "array", items: { type: "string" } },
      },
    })));
    // A failed reviewer comes back null; it never counts as clean.
    const done = reviews.filter(Boolean);
    if (!done.length) throw new Error("every reviewer failed");
    findings = done.flatMap(r => r.findings as string[]);
    if (done.length === reviews.length && done.every(r => r.verdict === "clean")) {
      return `Clean after ${round} round(s).`;
    }
    if (round === MAX_ROUNDS) break;

    log(`round ${round}: ${findings.length} finding(s), fixing`);
    await run({
      agent: "worker",
      task: `Fix only these review findings in ${target}; change nothing else:\n- ${findings.join("\n- ")}`,
    });
  }
  return `Stopped after ${MAX_ROUNDS} rounds. Remaining findings:\n- ${findings.join("\n- ")}`;
}) satisfies Workflow;
