/** subagents workflows: schema results, loops, trust, run cap, /workflow hand-off. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeSchema, parseJsonReply, validate } from "../../examples/extensions/subagents/schema.js";
import { body, lastUser, setup } from "./subagents-harness.js";

const text = (content: string) => () => ({ content });
const projectWf = (s: ReturnType<typeof setup>, name: string, body: string) =>
  writeFileSync(join(s.project, ".agent-sh", "workflows", name), body);
const userWf = (s: ReturnType<typeof setup>, name: string, body: string) =>
  writeFileSync(join(s.root, "workflows", name), body);

test("schema shorthand, validation, and JSON replies", () => {
  const schema = normalizeSchema({ verdict: { enum: ["clean", "issues"] }, n: { type: "integer" } });
  assert.deepEqual(schema.required, ["verdict", "n"]);
  assert.equal(validate({ verdict: "clean", n: 2 }, schema), null);
  assert.equal(validate({ verdict: "meh", n: 2 }, schema), '$.verdict must be one of ["clean","issues"]');
  assert.equal(validate({ verdict: "clean" }, schema), "$.n is required");
  assert.equal(validate({ items: ["a", 1] }, { type: "object", properties: { items: { type: "array", items: { type: "string" } } } }), "$.items[1] must be string");
  assert.deepEqual(parseJsonReply('Here:\n```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJsonReply('Sure, {"a": [1]} is it.'), { a: [1] });
  assert.throws(() => parseJsonReply("no json here"));
});

test("listing reads descriptions without running files and flags untrusted project workflows", () => {
  const s = setup({ reply: text("ok") });
  try {
    projectWf(s, "boom.ts", 'export const description = "Explodes on import";\nthrow new Error("ran at list time");\n');
    const d = s.description("run_workflow");
    assert.match(d, /- review-loop: Review in parallel/);
    assert.match(d, /- boom: Explodes on import \[untrusted: the user must run \/workflow trust boom\]/);
  } finally { s.cleanup(); }
});

test("a project workflow runs only after /workflow trust, and editing it revokes trust", async () => {
  const s = setup({ reply: text("ok") });
  try {
    projectWf(s, "hello.ts", 'export default async () => "v1";\n');
    let r = await s.exec("run_workflow", { name: "hello" });
    assert.equal(r.isError, true);
    assert.match(String(r.content), /\/workflow trust hello/);

    await s.command("workflow", "trust hello");
    r = await s.exec("run_workflow", { name: "hello" });
    assert.equal(body(r), "v1");

    projectWf(s, "hello.ts", 'export default async () => "v2";\n');
    r = await s.exec("run_workflow", { name: "hello" });
    assert.equal(r.isError, true);
  } finally { s.cleanup(); }
});

test("review-loop fixes and re-reviews until the typed verdict is clean", async () => {
  let extraction = 0;
  const s = setup({
    reply: (o) => ({ content: o.messages[0]!.content.includes("implementation subagent") ? "fixed" : `review of: ${lastUser(o)}` }),
    // Round 1: both reviewers report issues; round 2: both clean.
    invoke: () => JSON.stringify(++extraction <= 2
      ? { verdict: "issues", findings: [`finding ${extraction}`] }
      : { verdict: "clean", findings: [] }),
  });
  try {
    let progress = "";
    const r = await s.exec("run_workflow", { name: "review-loop", args: "HEAD~1" }, (c) => { progress += c; });
    assert.equal(body(r), "Clean after 2 round(s).");
    const workerTask = s.calls.find(c => c.messages[0]!.content.includes("implementation subagent"));
    assert.match(lastUser(workerTask!), /finding 1[\s\S]*finding 2/);
    assert.match(progress, /· round 1: 2 finding\(s\), fixing/);
    assert.match(progress, /\[3 worker\] done/);
    assert.equal(s.invokes.length, 4);
  } finally { s.cleanup(); }
});

test("schema extraction retries once, then fails the workflow", async () => {
  const replies = ["not json", '{"ok": true}'];
  const s = setup({ reply: text("answer"), invoke: () => replies.shift() ?? "still not json" });
  try {
    userWf(s, "typed.ts", 'export default async ({ run }) => (await run({ task: "t", tools: [], schema: { ok: { type: "boolean" } } })).ok;\n');
    let r = await s.exec("run_workflow", { name: "typed" });
    assert.equal(body(r), "true");
    assert.match(s.invokes[1]!.at(-1)!.content, /Invalid: reply contained no JSON/);

    r = await s.exec("run_workflow", { name: "typed" });
    assert.equal(r.isError, true);
    assert.match(String(r.content), /could not get output matching the schema/);
  } finally { s.cleanup(); }
});

test("a runaway loop stops at maxRunsPerWorkflow", async () => {
  const s = setup({ reply: text("again"), settings: { maxRunsPerWorkflow: 3 } });
  try {
    userWf(s, "forever.ts", 'export default async ({ run }) => { for (;;) await run({ task: "loop", tools: [] }); };\n');
    const r = await s.exec("run_workflow", { name: "forever" });
    assert.equal(r.isError, true);
    assert.match(String(r.content), /exceeded 3 subagent runs/);
    assert.equal(s.calls.length, 3);
  } finally { s.cleanup(); }
});

test("/workflow hands the run to the main agent; untrusted ones are refused up front", async () => {
  const s = setup({ reply: text("ok") });
  try {
    const submits: string[] = [];
    const errors: string[] = [];
    s.bus.on("agent:submit", (e) => { submits.push(e.query); });
    s.bus.on("ui:error", (e) => { errors.push(e.message); });

    await s.command("workflow", "review-loop  src/cli  only");
    assert.deepEqual(submits, ['Run the "review-loop" workflow with run_workflow and args "src/cli  only", then report its result.']);

    projectWf(s, "shady.ts", "export default async () => 1;\n");
    await s.command("workflow", "shady");
    assert.equal(submits.length, 1);
    assert.match(errors[0]!, /untrusted project workflow/);
  } finally { s.cleanup(); }
});

test("plain .js/.mjs workflows load, and edits take effect on the next run", async () => {
  const s = setup({ reply: text("ok") });
  try {
    userWf(s, "plain.js", "export default async ({ args }) => `js:${args}`;\n");
    userWf(s, "mod.mjs", "export default async () => ({ n: 1 });\n");
    assert.equal(body(await s.exec("run_workflow", { name: "plain", args: "x" })), "js:x");
    assert.equal(body(await s.exec("run_workflow", { name: "mod" })), '{\n  "n": 1\n}');
    userWf(s, "mod.mjs", "export default async () => ({ n: 2 });\n");
    assert.match(String((await s.exec("run_workflow", { name: "mod" })).content), /"n": 2/);
  } finally { s.cleanup(); }
});

test("subagents started by a workflow get neither spawn_agent nor run_workflow", async () => {
  const s = setup({ reply: text("ok") });
  try {
    userWf(s, "one.ts", 'export default async ({ run }) => run({ task: "t" });\n');
    await s.exec("run_workflow", { name: "one" });
    const names = s.calls[0]!.tools!.map(t => t.function.name);
    assert.ok(!names.includes("spawn_agent") && !names.includes("run_workflow"), names.join(","));
  } finally { s.cleanup(); }
});

test("run from $HOME, the user's workflows stay trusted", async () => {
  const s = setup({ reply: text("ok") });
  try {
    // A home dir whose .agent-sh is the storage root, so <cwd>/.agent-sh/workflows is the user dir.
    const home = join(s.root, "home");
    mkdirSync(home);
    symlinkSync(s.root, join(home, ".agent-sh"));
    s.h.define("cwd", () => home);
    userWf(s, "mine.ts", 'export default async () => "mine";\n');
    assert.equal(body(await s.exec("run_workflow", { name: "mine" })), "mine");
  } finally { s.cleanup(); }
});

test("verified-review dedupes across finders and keeps only findings most skeptics fail to refute", async () => {
  const submit = (args: unknown) => ({ tool_calls: [{ index: 0, id: "s", function: { name: "submit_result", arguments: JSON.stringify(args) } }] });
  const s = setup({ reply: (o) => {
    const task = lastUser(o);
    if (task.includes("Report only correctness")) return submit({ findings: [
      { file: "a.js", line: 3, claim: "real bug", scenario: "s" },
      { file: "b.js", line: 9, claim: "bogus", scenario: "s" },
    ] });
    if (task.includes("Report only tests")) return submit({ findings: [{ file: "a.js", line: 3, claim: "real bug, again", scenario: "s" }] });
    if (task.includes("Report only edge cases")) throw new Error("finder crashed");
    // Skeptics: "real bug" holds up except against the intent angle; "bogus" is refuted by everyone.
    const refuted = task.includes("bogus") || task.includes("Intent:");
    return submit({ refuted, reason: "checked" });
  } });
  try {
    let progress = "";
    const r = await s.exec("run_workflow", { name: "verified-review", args: "HEAD" }, (c) => { progress += c; });
    assert.equal(body(r), [
      "Confirmed:",
      "- a.js:3: real bug\n  scenario: s\n  upheld by 2/3",
      "",
      "Refuted (1):",
      "- b.js: bogus",
    ].join("\n"));
    assert.equal(s.calls.length, 3 + 2 * 3);
    assert.match(progress, /· 1 of 2 findings survived/);
  } finally { s.cleanup(); }
});
