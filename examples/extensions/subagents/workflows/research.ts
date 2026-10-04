import type { Workflow } from "../workflow-types.js";

export const description = "Answer a question with sources: split it, research the parts in parallel, check the key claims, combine";

export const args = {
  question: { required: true, help: "what to find out" },
  parts: { default: 4, help: "at most this many sub-questions" },
};

export default (async ({ run, map, args, log }) => {
  const plan = await run("plan", `
    Split this question into at most ${args.parts} independent sub-questions that together answer it:
    ${args.question}
  `, { returns: { parts: "string[]" } });
  const parts: string[] = plan.parts.slice(0, args.parts);
  log(`${parts.length} sub-question(s)`);

  const answers = await map(parts, (part) => run("research", part));
  const found = parts.map((part, i) => ({ part, answer: answers[i] })).filter((x) => x.answer);
  const missing = parts.filter((_, i) => !answers[i]);
  if (!found.length) throw new Error("no sub-question could be researched");

  const check = await run("reviewer", `
    Check these research notes for claims their sources don't support, contradictions between parts, and gaps
    that matter for the question: ${args.question}
    ${found.map((x) => `## ${x.part}\n${x.answer}`).join("\n\n")}
  `, { returns: { problems: "string[]" } });

  return run(null, `
    Answer the question from these research notes. Keep the sources for each key claim, say what stays uncertain,
    and don't add claims the notes don't support.
    Question: ${args.question}
    ${found.map((x) => `## ${x.part}\n${x.answer}`).join("\n\n")}
    Problems a reviewer found: ${check.problems.length ? check.problems.join("; ") : "none"}
    ${missing.length ? `Not researched (failed): ${missing.join("; ")}` : ""}
  `, { tools: [] });
}) satisfies Workflow;
