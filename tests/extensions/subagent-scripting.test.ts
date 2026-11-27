/** Workflow scripting ergonomics: schema shorthand, dedented tasks, run(agent, task, options), map(), declared args. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
      "import asyncio",
      "from agentsh import run",
      "async def main(args):",
      '    return " | ".join(await asyncio.gather(*[run(f"{word} {args.name}", tools=[]) for word in ["hello", "bye"]]))',
    ].join("\n"));
    assert.match(s.description("run_workflow"), /- greet: Greets twice/);
    const r = await s.exec("run_workflow", { name: "greet", args: "--name there" });
    assert.equal(body(r), "answer to hello there | answer to bye there");
  } finally { s.cleanup(); }
});

test("python: a shaped turn cut at its step limit raises RunCut with its reason", { skip: spawnSync("python3", ["--version"]).status !== 0 }, async () => {
  let n = 0;
  const s = setup({ reply: () => ({ tool_calls: [{ index: 0, id: `c${++n}`, function: { name: "grep", arguments: "{}" } }] }) });
  try {
    wf(s, "cut.py", [
      "from dataclasses import dataclass",
      "from agentsh import Agent, RunCut, RunError",
      "@dataclass",
      "class Out:",
      "    ok: bool",
      "async def main():",
      '    worker = Agent(tools=["grep"])',
      "    try:",
      '        await worker.ask("t", returns=Out, max_steps=2)',
      "    except RunCut as cut:",
      '        return f"cut {cut.reason} {isinstance(cut, RunError)}"',
      '    return "not cut"',
    ].join("\n"));
    const r = await s.exec("run_workflow", { name: "cut" });
    assert.equal(body(r), "cut iterations True");
    assert.equal(s.invokes.length, 0);
  } finally { s.cleanup(); }
});

test("python: config.steerDir hands <label>.steer.md to that agent once, renames it, and steers() lists it", { skip: spawnSync("python3", ["--version"]).status !== 0 }, async () => {
  let n = 0;
  const dir = mkdtempSync(join(tmpdir(), "steers-"));
  const steerDir = () => dir;
  const s = setup({
    reply: () => (++n === 1 ? { tool_calls: [{ index: 0, id: "c1", function: { name: "grep", arguments: "{}" } }] } : { content: "done" }),
    before: (h) => h.define("run:config", () => ({ base: "/", steerDir: dir })),
  });
  try {
    writeFileSync(join(steerDir(), "w1.steer.md"), "use the f150 band\n");
    wf(s, "steered.py", [
      "from agentsh import Agent",
      "async def main():",
      '    worker = Agent(tools=["grep"], label="w1")',
      '    await worker.ask("t")',
      '    return "|".join(await worker.steers())',
    ].join("\n"));
    const r = await s.exec("run_workflow", { name: "steered" });
    assert.equal(body(r), "use the f150 band");
    assert.ok(s.calls[1]!.messages.some(m => m.role === "user" && String(m.content).includes("f150")), "delivered after the tool round");
    const left = readdirSync(steerDir());
    assert.ok(!left.includes("w1.steer.md") && left.some(f => /^w1\.steer\.sent_\d{6}\.md$/.test(f)), left.join(","));
  } finally { s.cleanup(); rmSync(dir, { recursive: true, force: true }); }
});

test("python: provider:model in Agent; a turn's model override does not inherit the agent's provider", { skip: spawnSync("python3", ["--version"]).status !== 0 }, async () => {
  const s = setup({ reply: (o) => ({ content: `answer to ${lastUser(o)}` }) });
  try {
    wf(s, "prov.py", [
      "from agentsh import Agent, RunError",
      "async def main():",
      '    a = Agent(model="nope:m1", tools=[])',
      '    first = await a.ask("plain id: nope is no provider")',
      '    b = Agent(model="m1", provider="unknown-provider", tools=[])',
      '    second = await b.ask("override", model="m2")',
      "    try:",
      '        await b.ask("inherits")',
      '        third = "ran"',
      "    except RunError as e:",
      '        third = "refused"',
      '    return f"{first} | {second} | {third}"',
    ].join("\n"));
    const r = await s.exec("run_workflow", { name: "prov" });
    assert.equal(body(r), "answer to plain id: nope is no provider | answer to override | refused");
  } finally { s.cleanup(); }
});

test("python: Agent(role=...) and ask(role=...) resolve through the settings' roles", { skip: spawnSync("python3", ["--version"]).status !== 0 }, async () => {
  const s = setup({ reply: (o) => ({ content: `answer to ${lastUser(o)}` }), usage: 5,
                    settings: { roles: { worker: { model: "m-worker" }, reviewer: { model: "m-reviewer", thinking: "high" } } } });
  try {
    wf(s, "roles.py", [
      "from agentsh import Agent, RunError",
      "async def main():",
      '    a = Agent(role="worker", tools=[])',
      '    first = await a.ask("one")',
      '    second = await a.ask("two", role="reviewer")',
      "    try:",
      '        await Agent(role="ghost", tools=[]).ask("three")',
      '        third = "ran"',
      "    except RunError as e:",
      '        third = "refused" if "unknown role" in str(e) else str(e)',
      '    return f"{first} | {second} | {third}"',
    ].join("\n"));
    const r = await s.exec("run_workflow", { name: "roles" });
    assert.equal(body(r), "answer to one | answer to two | refused");
  } finally { s.cleanup(); }
});
