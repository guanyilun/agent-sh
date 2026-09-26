import type { Workflow } from "../workflow-types.js";

export const description = "Find issues from three angles, dedupe, and keep only findings that survive skeptics trying to refute them";

// Each finder looks a different way; each misses what the others catch.
const LENSES = [
  "correctness: wrong logic, unhandled cases, broken invariants",
  "tests: changed behavior with no test that would catch a regression",
  "edge cases: empty, huge or unusual inputs, error paths, concurrency",
];
// Each skeptic attacks a finding from a different angle.
const ANGLES = [
  "Trace the code: does the claimed behavior actually happen?",
  "Reachability: can real callers or inputs hit this path at all?",
  "Intent: is it handled elsewhere, documented, or deliberate?",
];
// 3 finders + 12 findings x 3 skeptics = 39 runs, under the default cap of 50.
const MAX_CHECKED = 12;

const FINDINGS = {
  findings: {
    type: "array",
    items: {
      type: "object",
      properties: {
        file: { type: "string" },
        line: { type: "integer" },
        claim: { type: "string" },
        scenario: { type: "string" },
      },
      required: ["file", "claim", "scenario"],
    },
  },
};
const VERDICT = { refuted: { type: "boolean" }, reason: { type: "string" } };

interface Finding { file: string; line?: number; claim: string; scenario: string }

export default (async ({ all, args, log }) => {
  const target = args || "the uncommitted changes (`git diff HEAD`)";

  const found: Finding[] = (await all(LENSES.map(lens => ({
    agent: "reviewer",
    task: `Review ${target}. Report only ${lens}. Give file, line, the claim, and a concrete scenario. Report nothing you can't point to in the code.`,
    schema: FINDINGS,
  })))).filter(Boolean).flatMap(r => r.findings);

  // Dedupe in code, not with an agent.
  const seen = new Set<string>();
  const unique = found.filter(f => {
    const key = `${f.file}:${f.line ?? f.claim.toLowerCase().slice(0, 40)}`;
    return !seen.has(key) && seen.add(key);
  });
  if (!unique.length) return "No findings.";
  const checked = unique.slice(0, MAX_CHECKED);
  if (unique.length > checked.length) {
    log(`checking ${checked.length} of ${unique.length} findings; not checked: ${unique.slice(MAX_CHECKED).map(f => f.claim).join("; ")}`);
  }

  // Each finding goes through its skeptics on its own; no waiting on the others.
  const judged = await Promise.all(checked.map(async f => {
    const votes = (await all(ANGLES.map(angle => ({
      agent: "reviewer",
      task: [
        `Try to refute this finding about ${target}. ${angle}`,
        `Finding: ${f.file}${f.line ? `:${f.line}` : ""}: ${f.claim}`,
        `Scenario: ${f.scenario}`,
        "Answer refuted=true if you can't confirm it from the code.",
      ].join("\n"),
      schema: VERDICT,
    })))).filter(Boolean);
    // A skeptic that failed counts as not upholding the finding.
    const upheld = votes.filter(v => !v.refuted).length;
    return { f, upheld, survived: upheld * 2 > ANGLES.length };
  }));

  const kept = judged.filter(j => j.survived);
  const dropped = judged.filter(j => !j.survived);
  log(`${kept.length} of ${checked.length} findings survived`);
  return [
    kept.length ? "Confirmed:" : "No finding survived verification.",
    ...kept.map(({ f, upheld }) =>
      `- ${f.file}${f.line ? `:${f.line}` : ""}: ${f.claim}\n  scenario: ${f.scenario}\n  upheld by ${upheld}/${ANGLES.length}`),
    ...(dropped.length ? ["", `Refuted (${dropped.length}):`, ...dropped.map(({ f }) => `- ${f.file}: ${f.claim}`)] : []),
  ].join("\n");
}) satisfies Workflow;
