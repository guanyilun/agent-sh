import type { Workflow } from "agent-sh-subagents";

export const description = "Find issues from three angles, dedupe, and keep only findings that survive skeptics trying to refute them";

export const args = {
  target: { default: "the uncommitted changes (`git diff HEAD`)", help: "what to review" },
};

const LENSES = [
  "correctness: wrong logic, unhandled cases, broken invariants",
  "tests: changed behavior with no test that would catch a regression",
  "edge cases: empty, huge or unusual inputs, error paths, concurrency",
];
const ANGLES = [
  "Trace the code: does the claimed behavior actually happen?",
  "Reachability: can real callers or inputs hit this path at all?",
  "Intent: is it handled elsewhere, documented, or deliberate?",
];
// 3 finders + a few merges + 10 findings x 3 skeptics stays under the default cap of 50.
const MAX_CHECKED = 10;

const FINDINGS = { findings: [{ file: "string", line: "integer?", claim: "string", scenario: "string" }] };
const DISTINCT = { issues: [{ line: "integer?", claim: "string", scenario: "string" }] };
const VERDICT = { refuted: "boolean", reason: "string" };

interface Finding { file: string; line?: number; claim: string; scenario: string }
const where = (f: Finding) => `${f.file}${f.line ? `:${f.line}` : ""}`;

export default (async ({ run, map, args, log }) => {
  const found: Finding[] = (await map(LENSES, (lens) => run("reviewer", `
    Review ${args.target}. Report only ${lens}. Give file, line, the claim, and a concrete scenario.
    Report nothing you can't point to in the code.
  `, { returns: FINDINGS }))).filter(Boolean).flatMap((r) => r.findings);

  // A merge run splits distinct bugs from repeats worded or cited differently.
  const groups = [...Map.groupBy(found, (f) => f.file).values()];
  const merged = await map(groups, (group) => group.length === 1 ? Promise.resolve({ issues: group }) : run("reviewer", `
    These findings about ${group[0]!.file} may repeat each other.
    Merge the ones describing the same problem, even if they cite different lines, and keep distinct problems separate. Don't add new ones.
    ${group.map((f, i) => `${i + 1}. line ${f.line ?? "?"}: ${f.claim}\n   scenario: ${f.scenario}`).join("\n")}
  `, { returns: DISTINCT }));
  const unique: Finding[] = merged.flatMap((m, i) => (m ?? { issues: groups[i]! }).issues.map((issue: Finding) => ({ ...issue, file: groups[i]![0]!.file })));
  if (unique.length < found.length) log(`merged ${found.length} findings into ${unique.length} distinct ones`);
  if (!unique.length) return "No findings.";

  const checked = unique.slice(0, MAX_CHECKED);
  if (unique.length > checked.length) {
    log(`checking ${checked.length} of ${unique.length} findings; not checked: ${unique.slice(MAX_CHECKED).map((f) => f.claim).join("; ")}`);
  }

  // A failed skeptic doesn't uphold a finding.
  const judged = await map(checked, async (f) => {
    const votes = (await map(ANGLES, (angle) => run("reviewer", `
      Try to refute this finding about ${args.target}. ${angle}
      Finding: ${where(f)}: ${f.claim}
      Scenario: ${f.scenario}
      Answer refuted=true if you can't confirm it from the code.
    `, { returns: VERDICT }))).filter(Boolean);
    const upheld = votes.filter((v) => !v.refuted).length;
    return { f, upheld, survived: upheld * 2 > ANGLES.length };
  });

  const kept = judged.filter((j) => j?.survived);
  const dropped = judged.filter((j) => j && !j.survived);
  log(`${kept.length} of ${checked.length} findings survived`);
  return [
    kept.length ? "Confirmed:" : "No finding survived verification.",
    ...kept.map((j) => `- ${where(j!.f)}: ${j!.f.claim}\n  scenario: ${j!.f.scenario}\n  upheld by ${j!.upheld}/${ANGLES.length}`),
    ...(dropped.length ? ["", `Refuted (${dropped.length}):`, ...dropped.map((j) => `- ${j!.f.file}: ${j!.f.claim}`)] : []),
  ].join("\n");
}) satisfies Workflow;
