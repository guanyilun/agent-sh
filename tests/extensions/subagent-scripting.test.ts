/** Workflow scripting ergonomics: schema shorthand, dedented tasks, run(agent, task, options), map(), declared args. */
import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { normalizeSchema, validate, example } from "../../examples/extensions/subagents/schema.js";
import { dedent } from "../../examples/extensions/subagents/workflows.js";
import { parseArgs, helpText, tokenize } from "../../examples/extensions/subagents/args.js";
import { body, lastUser, setup } from "./subagents-harness.js";

const submit = (args: unknown) => ({ tool_calls: [{ index: 0, id: "s", function: { name: "submit_result", arguments: JSON.stringify(args) } }] });
const wf = (s: ReturnType<typeof setup>, name: string, src: string) => writeFileSync(join(s.root, "workflows", name), src);

test("schema shorthand covers choices, lists, optional fields, nesting and lists of shapes", () => {
  const s = normalizeSchema({
    verdict: "clean | issues", findings: "string[]", score: "number?", id: "number | string",
    at: { file: "string", line: "integer" }, items: [{ name: "string", tags: "string[]?" }],
  });
  assert.deepEqual(s.required, ["verdict", "findings", "id", "at", "items"]);
  assert.equal(validate({ verdict: "clean", findings: [], id: "x", at: { file: "a", line: 1 }, items: [{ name: "n" }] }, s), null);
  assert.equal(validate({ verdict: "clean", findings: [], id: true, at: { file: "a", line: 1 }, items: [] }, s), "$.id must be number or string");
  assert.equal(validate({ verdict: "clean", findings: [], id: 1, at: { file: "a", line: 1 }, items: [{}] }, s), "$.items[0].name is required");
  assert.deepEqual(example(s), { verdict: "clean", findings: ["<findings>"], score: 0, id: 0, at: { file: "<file>", line: 0 }, items: [{ name: "<name>", tags: ["<tags>"] }] });
  assert.deepEqual(normalizeSchema({ type: "string" }), { type: "string" });
  assert.throws(() => normalizeSchema({ x: "a list of things" }), /can't read schema shorthand "a list of things"/);
});

test("tasks are dedented, keeping interpolated multi-line values intact", () => {
  const list = "- a\n- b";
  assert.equal(dedent(`
    Fix these:
      ${list}
    Then stop.
  `), "Fix these:\n  - a\n- b\nThen stop.");
  assert.equal(dedent("one line"), "one line");
});

test("declared args: flags, kebab-case, booleans, positional text, defaults, errors and help", () => {
  const spec = { target: { default: "src", help: "what to review" }, maxRounds: 3, strict: false, label: { required: true } };
  assert.deepEqual(parseArgs(spec, ["lib/cli", "--max-rounds", "5", "--strict", "--label=x"]), { target: "lib/cli", maxRounds: 5, strict: true, label: "x" });
  assert.deepEqual(parseArgs(spec, ["--label", "y", "--no-strict"]), { target: "src", maxRounds: 3, strict: false, label: "y" });
  assert.throws(() => parseArgs(spec, ["--label", "y", "--rounds", "2"]), /unknown argument --rounds/);
  assert.throws(() => parseArgs(spec, ["--label", "y", "--max-rounds", "many"]), /--max-rounds must be a number/);
  assert.throws(() => parseArgs(spec, []), /--label is required/);
  assert.deepEqual(tokenize(`--target "two words" --label 'x y' z`), ["--target", "two words", "--label", "x y", "z"]);
  assert.match(helpText("review.ts", spec, "Reviews things."), /Usage: agent-sh run review.ts \[--target <text>\] \[--max-rounds <number>\] \[--strict\] --label <text>\n\nReviews things\.\n\nArguments:\n  --target <text>\s+what to review; default: "src"/);
});

test("run(agent, task, { returns }) and run(null, task) share one call shape", async () => {
  const s = setup({ reply: (o) => o.tools?.some((t) => t.function.name === "submit_result") ? submit({ ok: true }) : { content: `answer to ${lastUser(o)}` } });
  try {
    wf(s, "calls.ts", [
      "export default async ({ run }) => {",
      '  const typed = await run("scout", "check", { returns: { ok: "boolean" } });',
      "  const text = await run(null, `",
      "    first line",
      "      indented",
      "  `, { tools: [] });",
      "  return JSON.stringify({ typed, text });",
      "};",
    ].join("\n"));
    const r = await s.exec("run_workflow", { name: "calls" });
    assert.deepEqual(JSON.parse(body(r)), { typed: { ok: true }, text: "answer to first line\n  indented" });
  } finally { s.cleanup(); }
});

test("map() keeps order, turns a failed item into null, and still stops on the budget", async () => {
  const s = setup({ reply: (o) => { if (lastUser(o) === "b") throw new Error("down"); return { content: lastUser(o).toUpperCase() }; }, usage: 10 });
  try {
    wf(s, "fan.ts", 'export default async ({ run, map }) => JSON.stringify(await map(["a", "b", "c"], (x) => run(null, x, { tools: [] })));\n');
    let progress = "";
    const r = await s.exec("run_workflow", { name: "fan" }, (c) => { progress += c; });
    assert.equal(body(r), '["A",null,"C"]');
    assert.match(progress, /· map item 2 failed: down/);

    wf(s, "spend.ts", 'export default async ({ run, map }) => map([1, 2, 3, 4], async (i) => { for (;;) await run(null, `t${i}`, { tools: [] }); });\n');
    const stopped = await s.exec("run_workflow", { name: "spend", budgetTokens: 25 });
    assert.equal(stopped.isError, true);
    assert.match(String(stopped.content), /token budget of 25 exhausted/);
  } finally { s.cleanup(); }
});

test("declared args parse run_workflow's free text, and a bad flag fails with the help text", async () => {
  const s = setup({ reply: () => ({ content: "ok" }) });
  try {
    wf(s, "params.ts", 'export const args = { target: "src", rounds: 1 };\nexport default async ({ args }) => JSON.stringify(args);\n');
    assert.deepEqual(JSON.parse(body(await s.exec("run_workflow", { name: "params", args: '"lib dir" --rounds 4' }))), { target: "lib dir", rounds: 4 });
    const bad = await s.exec("run_workflow", { name: "params", args: "--nope 1" });
    assert.equal(bad.isError, true);
    assert.match(String(bad.content), /unknown argument --nope[\s\S]*Usage: agent-sh run params\.ts \[--target <text>\] \[--rounds <number>\]/);
  } finally { s.cleanup(); }
});

test("a .py file in the workflows folder is listed and runs through run_workflow", { skip: spawnSync("python3", ["--version"]).status !== 0 }, async () => {
  const s = setup({ reply: (o) => ({ content: `answer to ${lastUser(o)}` }) });
  try {
    wf(s, "greet.py", [
      'description = "Greets twice"',
      'args = dict(name="world")',
      "from agentsh import map, run",
      "async def main(args):",
      '    return " | ".join(await map(["hello", "bye"], lambda w: run(None, f"{w} {args.name}", tools=[])))',
    ].join("\n"));
    assert.match(s.description("run_workflow"), /- greet: Greets twice/);
    const r = await s.exec("run_workflow", { name: "greet", args: "--name there" });
    assert.equal(body(r), "answer to hello there | answer to bye there");
  } finally { s.cleanup(); }
});
