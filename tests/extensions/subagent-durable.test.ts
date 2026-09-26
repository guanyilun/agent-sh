/** Durable workflow runs: submit_result, null on failure, budget, resume, transcripts. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RunStore } from "../../examples/extensions/subagents/runs.js";
import { body, lastUser, setup } from "./subagents-harness.js";

type S = ReturnType<typeof setup>;
const wf = (s: S, name: string, src: string) => writeFileSync(join(s.root, "workflows", name), src);
const store = (s: S) => new RunStore(join(s.root, "workflow-runs"));
const submit = (args: unknown) => ({
  tool_calls: [{ index: 0, id: `s${Math.random()}`, function: { name: "submit_result", arguments: JSON.stringify(args) } }],
});
const runId = (r: { content: unknown }) => String(r.content).match(/\(workflow run (\S+);/)![1]!;

test("a typed run takes the result from submit_result and stops there, with no extraction call", async () => {
  const s = setup({ reply: () => submit({ verdict: "clean", n: 2 }) });
  try {
    wf(s, "typed.ts", 'export default async ({ run }) => run({ task: "t", tools: [], schema: { verdict: { enum: ["clean", "issues"] }, n: { type: "integer" } } });\n');
    const r = await s.exec("run_workflow", { name: "typed" });
    assert.deepEqual(JSON.parse(body(r)), { verdict: "clean", n: 2 });
    assert.equal(s.calls.length, 1);
    assert.equal(s.invokes.length, 0);
    assert.ok(s.calls[0]!.tools!.some(t => t.function.name === "submit_result"));
  } finally { s.cleanup(); }
});

test("an invalid submission is refused so the agent can fix it; non-object schemas are wrapped", async () => {
  const replies = [submit({ result: ["a", 3] }), submit({ result: ["a", "b"] })];
  const s = setup({ reply: () => replies.shift()! });
  try {
    wf(s, "list.ts", 'export default async ({ run }) => (await run({ task: "t", tools: [], schema: { type: "array", items: { type: "string" } } })).join("+");\n');
    const r = await s.exec("run_workflow", { name: "list" });
    assert.equal(body(r), "a+b");
    assert.match(s.calls[1]!.messages.at(-1)!.content, /Invalid: \$\.result\[1\] must be string/);
  } finally { s.cleanup(); }
});

test("all() turns a failed run into null; run() still throws", async () => {
  const s = setup({ reply: (o) => { if (lastUser(o) === "boom") throw new Error("provider down"); return { content: "fine" }; } });
  try {
    wf(s, "mixed.ts", [
      'export default async ({ run, all }) => {',
      '  const r = await all([{ task: "ok", tools: [] }, { task: "boom", tools: [] }]);',
      '  let thrown = "";',
      '  try { await run({ task: "boom", tools: [] }); } catch (e) { thrown = e.message; }',
      '  return JSON.stringify({ r, thrown });',
      '};',
    ].join("\n"));
    let progress = "";
    const r = await s.exec("run_workflow", { name: "mixed" }, (c) => { progress += c; });
    assert.deepEqual(JSON.parse(body(r)), { r: ["fine", null], thrown: "provider down" });
    assert.match(progress, /\[2 ad-hoc\] failed: provider down/);
  } finally { s.cleanup(); }
});

test("the token budget is visible to the script and stops new runs once spent", async () => {
  const s = setup({ reply: () => ({ content: "x" }), usage: 10 });
  try {
    wf(s, "spend.ts", [
      'export default async ({ run, budget, log }) => {',
      '  for (;;) { await run({ task: "t", tools: [] }); log(`spent ${budget.spent()} of ${budget.total}`); }',
      '};',
    ].join("\n"));
    let progress = "";
    const r = await s.exec("run_workflow", { name: "spend", budgetTokens: 25 }, (c) => { progress += c; });
    assert.equal(r.isError, true);
    assert.match(String(r.content), /token budget of 25 exhausted/);
    assert.equal(s.calls.length, 3);
    assert.match(progress, /spent 30 of 25/);
    assert.equal(store(s).get(runId(r))!.tokens, 30);
  } finally { s.cleanup(); }
});

test("resume reuses journaled runs, reruns the failed one, and reuses the earlier args", async () => {
  let failC = true;
  const s = setup({ reply: (o) => {
    const task = lastUser(o);
    if (task.startsWith("C") && failC) throw new Error("flaky");
    return { content: `did ${task}` };
  } });
  try {
    wf(s, "abc.ts", [
      'export default async ({ run, args }) => {',
      '  const a = await run({ task: "A " + args, tools: [] });',
      '  const b = await run({ task: "B after " + a, tools: [] });',
      '  return run({ task: "C after " + b, tools: [] });',
      '};',
    ].join("\n"));
    const first = await s.exec("run_workflow", { name: "abc", args: "x" });
    assert.equal(first.isError, true);
    const firstId = runId(first);
    assert.equal(store(s).get(firstId)!.status, "failed");
    assert.equal(s.calls.length, 3);

    failC = false;
    let progress = "";
    const second = await s.exec("run_workflow", { resume: firstId }, (c) => { progress += c; });
    assert.equal(body(second), "did C after did B after did A x");
    assert.equal(s.calls.length, 4);
    assert.match(progress, new RegExp(`\\[1 ad-hoc\\] reused from ${firstId}[\\s\\S]*\\[2 ad-hoc\\] reused from ${firstId}`));
    const rec = store(s).get(runId(second))!;
    assert.deepEqual([rec.status, rec.resumedFrom, rec.args], ["done", firstId, "x"]);
    assert.equal(store(s).journal(rec.id).length, 3);
  } finally { s.cleanup(); }
});

test("replay stops at the first run whose inputs changed; later matching runs run live", async () => {
  const s = setup({ reply: (o) => ({ content: `did ${lastUser(o)}` }) });
  try {
    wf(s, "seq.ts", 'export default async ({ run }) => { await run({ task: "A", tools: [] }); await run({ task: "B", tools: [] }); return run({ task: "C", tools: [] }); };\n');
    const first = await s.exec("run_workflow", { name: "seq" });
    wf(s, "seq.ts", 'export default async ({ run }) => { await run({ task: "A", tools: [] }); await run({ task: "B2", tools: [] }); return run({ task: "C", tools: [] }); };\n');
    let progress = "";
    await s.exec("run_workflow", { resume: runId(first) }, (c) => { progress += c; });
    assert.equal(s.calls.length, 3 + 2);
    assert.match(progress, /replay stopped at run 2: its inputs changed; 1 run\(s\) reused/);
  } finally { s.cleanup(); }
});

test("each run writes a transcript; /workflow runs lists runs and flags interrupted ones", async () => {
  const s = setup({ reply: () => ({ content: "answer" }) });
  try {
    wf(s, "one.ts", 'export default async ({ run }) => run({ task: "t", tools: [] });\n');
    const r = await s.exec("run_workflow", { name: "one" });
    const id = runId(r);
    const lines = readFileSync(join(s.root, "workflow-runs", id, "agents", "1.jsonl"), "utf8").trim().split("\n").map(l => JSON.parse(l));
    assert.deepEqual(lines.map(l => l.type === "message" ? `${l.type}:${l.role}` : l.type), ["start", "message:user", "message:assistant", "end"]);

    // A run another process left marked "running" (e.g. it crashed).
    const dead = store(s).create("one", "f", "", undefined);
    const infos: string[] = [];
    s.bus.on("ui:info", (e) => { infos.push(e.message); });
    await s.command("workflow", "runs");
    assert.match(infos[0]!, new RegExp(`${id}  one  done`));
    assert.match(new RunStore(join(s.root, "workflow-runs")).list().map(x => `${x.id}:${x.interrupted}`).join(" "), new RegExp(`${dead.id}:true`));
  } finally { s.cleanup(); }
});

test("run.json keeps the token count current before the run finishes", async () => {
  let release!: () => void;
  let secondStarted!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  const started = new Promise<void>((r) => { secondStarted = r; });
  const s = setup({ reply: async (o) => {
    if (lastUser(o) === "second") { secondStarted(); await held; }
    return { content: "x" };
  }, usage: 7 });
  try {
    wf(s, "two.ts", 'export default async ({ run }) => { await run({ task: "first", tools: [] }); return run({ task: "second", tools: [] }); };\n');
    const running = s.exec("run_workflow", { name: "two" });
    await started;
    const [live] = store(s).list();
    assert.deepEqual([live!.status, live!.tokens], ["running", 7]);
    release();
    await running;
  } finally { s.cleanup(); }
});
