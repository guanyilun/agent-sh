/** Durable workflow runs: submit_result, null on failure, budget, resume, transcripts. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunStore } from "../../examples/extensions/subagents/runs.js";
import { runWorkflow } from "../../examples/extensions/subagents/workflows.js";
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
    assert.deepEqual(lines.map(l => l.type === "message" ? `${l.type}:${l.role}` : l.type), ["start", "running", "message:user", "message:assistant", "end"]);
    assert.ok(lines.every(l => typeof l.at === "number"));

    // A run another process left marked "running" with no heartbeat since (e.g. it crashed).
    const dead = { id: "20260101-000000-dead" };
    const deadDir = join(s.root, "workflow-runs", dead.id);
    mkdirSync(deadDir, { recursive: true });
    writeFileSync(join(deadDir, "run.json"), JSON.stringify({ id: dead.id, workflow: "one", file: "f", args: "", status: "running", startedAt: new Date(0).toISOString(), tokens: 0 }));
    utimesSync(join(deadDir, "run.json"), new Date(0), new Date(0));
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

test("status shows each subagent queued, working or done; a run with a heartbeat counts as running", () => {
  const root = join(tmpdir(), `runs-${Date.now()}`);
  const store = new RunStore(root);
  const run = store.create("wf", "f", "");
  const t0 = Date.parse(run.record.startedAt);
  const events: Record<number, Record<string, unknown>[]> = {
    1: [{ type: "start", task: "first\nmore", at: t0 }, { type: "running", at: t0 + 1000 }, { type: "end", ok: true, at: t0 + 61_000 }],
    2: [{ type: "start", task: "second", at: t0 }, { type: "running", at: t0 + 2000 }],
    3: [{ type: "start", task: "third", at: t0 }],
  };
  for (const [n, evs] of Object.entries(events)) writeFileSync(join(run.dir, "agents", `${n}.jsonl`), evs.map(e => JSON.stringify(e)).join("\n") + "\n");
  // Read as another process would: a fresh store, which only has the heartbeat to go on.
  const text = new RunStore(root).status(undefined, t0 + 122_000);
  assert.equal(text, [
    `${run.id}  wf  running, 2m02s, 0 tokens`,
    "  # 1  done      1m00s  first",
    "  # 2  working   2m00s  second",
    "  # 3  queued    2m02s  third",
  ].join("\n"));
  run.finish("done");
  assert.match(new RunStore(root).status(run.id), /wf {2}done/);
  assert.equal(new RunStore(root).status("nope"), "No workflow run nope.");
});

test("a quiet workflow prints how many subagents are working and queued", async () => {
  const root = join(tmpdir(), `quiet-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  const file = join(root, "q.mjs");
  const lines: string[] = [];
  let slots = 1;
  const waiting: (() => void)[] = [];
  const mod = { default: async ({ run }: { run: (s: { task: string }) => Promise<unknown> }) => Promise.all(["a", "b", "c"].map((task) => run({ task }))) };
  await runWorkflow({ name: "q", description: "", file, scope: "user" }, "", {
    maxRuns: 10,
    complete: async () => "",
    runTask: async (_spec, ctl) => {
      if (slots > 0) slots--; else await new Promise<void>((r) => waiting.push(r));
      ctl.onStart?.();
      await new Promise((r) => setTimeout(r, 120));
      waiting.shift()?.();
      if (!waiting.length) slots++;
      return { text: "ok" };
    },
  }, new AbortController().signal, (l) => lines.push(l), { run: new RunStore(root).create("q", file, ""), module: mod, quietMs: 50 });
  assert.ok(lines.includes("[1 ad-hoc] started"));
  assert.ok(lines.some((l) => /^· 1 working, 2 queued, 0 finished; 0 min, 0 tokens$/.test(l)), lines.join("\n"));
});

test("pipeline sends each item to its next stage without waiting for the others", async () => {
  const order: string[] = [];
  const s = setup({ reply: async (o) => {
    const task = lastUser(o);
    // Item "slow" takes longer in stage 1, so "fast" reaches stage 2 first.
    await new Promise((r) => setTimeout(r, task === "read slow" ? 80 : 5));
    order.push(task);
    return { content: `${task} ok` };
  } });
  try {
    wf(s, "p.ts", [
      'export default async ({ run, pipeline }) => pipeline(["slow", "fast"],',
      '  (item) => run({ task: "read " + item, tools: [] }),',
      '  (prev, item) => run({ task: "check " + item, tools: [] }));',
    ].join("\n"));
    const r = await s.exec("run_workflow", { name: "p" });
    assert.equal(r.isError, false, String(r.content));
    assert.ok(order.indexOf("check fast") < order.indexOf("read slow"), order.join(", "));
    assert.match(body(r), /check slow ok[\s\S]*check fast ok/);
  } finally { s.cleanup(); }
});

test("resume matches calls by where they sit, not by which item finished first", async () => {
  let failB = true;
  let slow = "a";
  const s = setup({ reply: async (o) => {
    const task = lastUser(o);
    await new Promise((r) => setTimeout(r, task.endsWith(slow) ? 60 : 5));
    if (task === "two b" && failB) throw new Error("boom");
    return { content: `did ${task}` };
  } });
  try {
    wf(s, "m.ts", [
      'export default async ({ run, map }) => map(["a", "b"], async (x) => {',
      '  await run({ task: "one " + x, tools: [] });',
      '  return run({ task: "two " + x, tools: [] });',
      '});',
    ].join("\n"));
    const first = await s.exec("run_workflow", { name: "m" });
    const calls = s.calls.length;
    // Now "b" is the slow one, so its calls happen in a different global order.
    failB = false; slow = "b";
    let progress = "";
    const second = await s.exec("run_workflow", { resume: runId(first) }, (c) => { progress += c; });
    assert.match(body(second), /did two a[\s\S]*did two b/);
    assert.equal(s.calls.length - calls, 1, "only the failed call runs again");
    assert.equal((progress.match(/reused from/g) ?? []).length, 3);
  } finally { s.cleanup(); }
});

test("run() takes an inline system prompt, model, thinking and label; system with a named agent is refused", async () => {
  const s = setup({ reply: () => ({ content: "ok" }) });
  try {
    wf(s, "inline.ts", [
      'const proofreader = { system: "You proofread.", tools: [], model: "m-1", label: "proofreader" };',
      'export default async ({ run }) => run({ ...proofreader, task: "the text" });',
    ].join("\n"));
    let progress = "";
    const r = await s.exec("run_workflow", { name: "inline" }, (c) => { progress += c; });
    assert.equal(body(r), "ok");
    assert.match(s.calls[0]!.messages[0]!.content, /^You proofread\./);
    assert.equal((s.calls[0] as { model?: string }).model, "m-1");
    assert.deepEqual(s.calls[0]!.tools ?? [], []);
    assert.match(progress, /\[1 proofreader\] done/);

    wf(s, "bad.ts", 'export default async ({ run }) => run("reviewer", "t", { system: "x" });\n');
    const bad = await s.exec("run_workflow", { name: "bad" });
    assert.match(String(bad.content), /"system" is for ad-hoc runs; reviewer has its own prompt/);
  } finally { s.cleanup(); }
});

test("a journal from before call ids still resumes by call order", async () => {
  let failC = true;
  const s = setup({ reply: (o) => {
    if (lastUser(o) === "C" && failC) throw new Error("boom");
    return { content: `did ${lastUser(o)}` };
  } });
  try {
    wf(s, "old.ts", 'export default async ({ run }) => [await run({ task: "A", tools: [] }), await run({ task: "B", tools: [] }), await run({ task: "C", tools: [] })].join(", ");\n');
    const first = await s.exec("run_workflow", { name: "old" });
    const journal = join(s.root, "workflow-runs", runId(first), "journal.jsonl");
    writeFileSync(journal, readFileSync(journal, "utf8").split("\n").filter(Boolean)
      .map((l) => { const e = JSON.parse(l); delete e.id; return JSON.stringify(e); }).join("\n") + "\n");
    failC = false;
    const before = s.calls.length;
    const second = await s.exec("run_workflow", { resume: runId(first) });
    assert.equal(body(second), "did A, did B, did C");
    assert.equal(s.calls.length - before, 1);
  } finally { s.cleanup(); }
});

test("race keeps the first result that passes, cancels the rest, and resume runs only the winner", async () => {
  let failAfter = true;
  let slowSignal: AbortSignal | undefined;
  const s = setup({ reply: async (o) => {
    const task = lastUser(o);
    if (task === "try slow") slowSignal = (o as { signal?: AbortSignal }).signal;
    await new Promise((r) => setTimeout(r, task === "try slow" ? 80 : 5));
    if (task === "after" && failAfter) throw new Error("boom");
    return { content: `did ${task}` };
  } });
  try {
    wf(s, "r.ts", [
      'export default async ({ run, race }) => {',
      '  const won = await race(["slow", "bad", "fast"], async (x) => {',
      '    await run({ task: "try " + x, tools: [] });',
      '    return run({ task: "polish " + x, tools: [] });',
      '  }, (v) => !v.includes("bad"));',
      '  const none = await race(["bad"], (x) => run({ task: "try " + x, tools: [] }), () => false);',
      '  await run({ task: "after", tools: [] });',
      '  return JSON.stringify({ won, none });',
      '};',
    ].join("\n"));
    let progress = "";
    const first = await s.exec("run_workflow", { name: "r" }, (c) => { progress += c; });
    assert.equal(first.isError, true);
    assert.equal(slowSignal?.aborted, true);
    assert.match(progress, /\[1 ad-hoc\] cancelled/);
    assert.ok(!s.calls.some((c) => lastUser(c) === "polish slow"));
    const calls = s.calls.length;

    failAfter = false;
    progress = "";
    const second = await s.exec("run_workflow", { resume: runId(first) }, (c) => { progress += c; });
    assert.deepEqual(JSON.parse(body(second)), { won: { value: "did polish fast", index: 2 }, none: null });
    assert.deepEqual(s.calls.slice(calls).map(lastUser), ["after"], "the losers of the first race don't run again");
    assert.equal((progress.match(/reused from/g) ?? []).length, 3);
  } finally { s.cleanup(); }
});

test("agent() keeps one conversation across ask() turns, and resume restores it", async () => {
  let failThird = true;
  const s = setup({ reply: (o) => {
    if (lastUser(o) === "third" && failThird) throw new Error("boom");
    return { content: `${lastUser(o)} sees ${o.messages.filter((m) => m.role === "user").length}` };
  } });
  try {
    const script = (first: string) => [
      'export default async ({ agent }) => {',
      '  const a = agent(null, { tools: [], system: "You remember." });',
      `  const one = await a.ask("${first}");`,
      '  const [two, three] = await Promise.all([a.ask("second"), a.ask("third")]);',
      '  return [one, two, three].join("; ");',
      '};',
    ].join("\n");
    wf(s, "chat.ts", script("first"));
    const first = await s.exec("run_workflow", { name: "chat" });
    assert.equal(first.isError, true);
    assert.equal(s.calls.length, 3);
    assert.equal(s.calls[1]!.messages[0]!.content.startsWith("You remember."), true);

    failThird = false;
    const second = await s.exec("run_workflow", { resume: runId(first) });
    assert.equal(body(second), "first sees 1; second sees 2; third sees 3");
    assert.equal(s.calls.length, 4, "only the failed turn runs again, with the earlier turns restored");

    // A changed first turn makes every later turn run again.
    wf(s, "chat.ts", script("first!"));
    const third = await s.exec("run_workflow", { resume: runId(second) });
    assert.equal(body(third), "first! sees 1; second sees 2; third sees 3");
    assert.equal(s.calls.length, 7);
  } finally { s.cleanup(); }
});

test("step() records the script's own work, so resume doesn't do it again", async () => {
  let failAfter = true;
  const counter = globalThis as { __steps?: number };
  counter.__steps = 0;
  const s = setup({ reply: (o) => { if (failAfter) throw new Error("boom"); return { content: `did ${lastUser(o)}` }; } });
  try {
    wf(s, "st.ts", [
      "export default async ({ run, step }) => {",
      '  const n = await step("count", () => ({ calls: ++globalThis.__steps }));',
      '  return `${n.calls} ${await run({ task: "after", tools: [] })}`;',
      "};",
    ].join("\n"));
    const first = await s.exec("run_workflow", { name: "st" });
    assert.equal(first.isError, true);

    failAfter = false;
    let progress = "";
    const second = await s.exec("run_workflow", { resume: runId(first) }, (c) => { progress += c; });
    assert.equal(body(second), "1 did after");
    assert.equal(counter.__steps, 1);
    assert.match(progress, /\[step count\] reused from/);
  } finally { s.cleanup(); }
});
