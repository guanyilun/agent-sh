/** subagents workflows: schema results, loops, trust, run cap, /workflow hand-off. */
import test from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeSchema, parseJsonReply, validate } from "../../examples/extensions/subagents/schema.js";
import { body, lastUser, setup } from "./subagents-harness.js";

const text = (content: string) => () => ({ content });
const EXAMPLE = (name: string) => fileURLToPath(new URL(`../../examples/workflows/${name}`, import.meta.url));
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
    assert.match(d, /- review-loop: Review a result from several angles in parallel/);
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
    reply: (o) => ({ content: o.messages[0]!.content.includes("You carry out the task described") ? "fixed" : `review of: ${lastUser(o)}` }),
    // Round 1: both reviewers report issues; round 2: both clean.
    invoke: () => JSON.stringify(++extraction <= 2
      ? { verdict: "issues", findings: [`finding ${extraction}`] }
      : { verdict: "clean", findings: [] }),
  });
  try {
    let progress = "";
    const r = await s.exec("run_workflow", { name: "review-loop", args: "HEAD~1" }, (c) => { progress += c; });
    assert.equal(body(r), "Clean after 2 round(s).");
    const workerTask = s.calls.find(c => c.messages[0]!.content.includes("You carry out the task described"));
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

test("verified-review merges repeats across lines but keeps distinct findings, then keeps what skeptics can't refute", async () => {
  const submit = (args: unknown) => ({ tool_calls: [{ index: 0, id: "s", function: { name: "submit_result", arguments: JSON.stringify(args) } }] });
  const s = setup({ reply: (o) => {
    const task = lastUser(o);
    if (task.includes("Report only correctness")) return submit({ findings: [
      { file: "a.js", line: 3, claim: "real bug", scenario: "s" },
      { file: "a.js", line: 3, claim: "second bug", scenario: "s2" },
      { file: "b.js", line: 9, claim: "bogus", scenario: "s" },
    ] });
    // The same bug, cited on a different line.
    if (task.includes("Report only tests")) return submit({ findings: [{ file: "a.js", line: 4, claim: "real bug, reworded", scenario: "s" }] });
    if (task.includes("Report only edge cases")) throw new Error("finder crashed");
    if (task.includes("may repeat each other")) {
      assert.match(task, /line 3: real bug[\s\S]*line 3: second bug[\s\S]*line 4: real bug, reworded/);
      return submit({ issues: [{ line: 3, claim: "real bug", scenario: "s" }, { line: 3, claim: "second bug", scenario: "s2" }] });
    }
    // Skeptics: "real bug" holds up except against the intent angle; the others are refuted.
    const refuted = !task.includes("real bug") || task.includes("Intent:");
    return submit({ refuted, reason: "checked" });
  } });
  try {
    copyFileSync(EXAMPLE("verified-review.ts"), join(s.root, "workflows", "verified-review.ts"));
    let progress = "";
    const r = await s.exec("run_workflow", { name: "verified-review", args: "HEAD" }, (c) => { progress += c; });
    assert.equal(body(r), [
      "Confirmed:",
      "- a.js:3: real bug\n  scenario: s\n  upheld by 2/3",
      "",
      "Refuted (2):",
      "- a.js: second bug",
      "- b.js: bogus",
    ].join("\n"));
    assert.equal(s.calls.length, 3 + 1 + 3 * 3);
    assert.match(progress, /· merged 4 findings into 3 distinct ones/);
    assert.match(progress, /· 1 of 3 findings survived/);
  } finally { s.cleanup(); }
});

test("an edited .ts workflow runs its new code in the same session; its temporary copy is removed and never listed", async () => {
  const s = setup({ reply: text("ok") });
  try {
    const dir = join(s.root, "workflows");
    userWf(s, "ver.ts", 'export default async () => "v1";\n');
    assert.equal(body(await s.exec("run_workflow", { name: "ver" })), "v1");
    userWf(s, "ver.ts", 'export default async () => "v2";\n');
    assert.equal(body(await s.exec("run_workflow", { name: "ver" })), "v2");
    assert.deepEqual(readdirSync(dir), ["ver.ts"]);

    writeFileSync(join(dir, ".ver.0123456789ab.abcdef.ts"), 'export const description = "leftover";\n');
    assert.doesNotMatch(s.description("run_workflow"), /leftover/);
  } finally { s.cleanup(); }
});

test("research splits the question, researches the parts in parallel, checks the claims, and combines", async () => {
  const submit = (args: unknown) => ({ tool_calls: [{ index: 0, id: "s", function: { name: "submit_result", arguments: JSON.stringify(args) } }] });
  const s = setup({ reply: (o) => {
    const task = lastUser(o);
    if (task.includes("independent sub-questions")) return submit({ parts: ["part A", "part B", "part C"] });
    if (task === "part B") throw new Error("search down");
    if (task.startsWith("part ")) return { content: `notes on ${task} [source]` };
    if (task.includes("claims their sources don't support")) return submit({ problems: ["A overstates"] });
    assert.match(task, /notes on part A[\s\S]*notes on part C/);
    assert.match(task, /A overstates/);
    assert.match(task, /Not researched \(failed\): part B/);
    return { content: "the answer" };
  } });
  try {
    const r = await s.exec("run_workflow", { name: "research", args: '"why is the sky blue" --parts 3' });
    assert.equal(body(r), "the answer");
    assert.match(lastUser(s.calls[0]!), /at most 3 independent sub-questions[\s\S]*why is the sky blue/);
  } finally { s.cleanup(); }
});

test("a shaped run cut at its step limit fails with a cut error, unless onCut is extract", async () => {
  let n = 0;
  const s = setup({
    reply: () => ({ tool_calls: [{ index: 0, id: `c${++n}`, function: { name: "grep", arguments: "{}" } }] }),
    invoke: () => '{"ok": true}',
  });
  try {
    userWf(s, "cut.ts", 'export default async ({ run }) => (await run({ task: "t", tools: ["grep"], maxSteps: 2, schema: { ok: { type: "boolean" } } })).ok;\n');
    let r = await s.exec("run_workflow", { name: "cut" });
    assert.equal(r.isError, true);
    assert.match(String(r.content), /cut: the agent stopped at its step limit before submitting/);
    assert.equal(s.invokes.length, 0);

    userWf(s, "cutx.ts", 'export default async ({ run }) => (await run({ task: "t", tools: ["grep"], maxSteps: 2, onCut: "extract", schema: { ok: { type: "boolean" } } })).ok;\n');
    r = await s.exec("run_workflow", { name: "cutx" });
    assert.equal(body(r), "true");
    assert.equal(s.invokes.length, 1);
  } finally { s.cleanup(); }
});

test("config.concurrency as a dict: a model's own pool, the rest in the default pool", async () => {
  const active: Record<string, number> = {};
  const peak: Record<string, number> = {};
  const s = setup({
    reply: async (o) => {
      const which = lastUser(o).startsWith("slow") ? "slow" : "fast";
      active[which] = (active[which] ?? 0) + 1;
      peak[which] = Math.max(peak[which] ?? 0, active[which]!);
      await new Promise(r => setTimeout(r, 40));
      active[which]!--;
      return { content: "ok" };
    },
    before: (h) => h.define("run:config", () => ({ base: "/", concurrency: { default: 3, "slow-model": 1 } })),
  });
  try {
    userWf(s, "pools.ts", [
      "export default async ({ run }) => {",
      '  await Promise.all([1, 2, 3].flatMap(i => [run({ task: `slow ${i}`, tools: [], model: "slow-model" }), run({ task: `fast ${i}`, tools: [] })]));',
      '  return "done";',
      "};",
    ].join("\n"));
    const r = await s.exec("run_workflow", { name: "pools" });
    assert.equal(body(r), "done");
    assert.equal(peak.slow, 1);
    assert.equal(peak.fast, 3);
  } finally { s.cleanup(); }
});

test("config.control: a 0600 socket answers status and steers a running agent by label, then is removed", async () => {
  const { mkdtempSync, rmSync, statSync, existsSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const net = await import("node:net");
  const dir = mkdtempSync(join(tmpdir(), "ctl-"));
  const sock = join(dir, "c.sock");
  const ask = (req: unknown) => new Promise<any>((resolve, reject) => {
    const c = net.createConnection(sock, () => c.write(JSON.stringify(req) + "\n"));
    let buf = "";
    c.on("data", (d) => { buf += d; if (buf.includes("\n")) { resolve(JSON.parse(buf)); c.end(); } });
    c.on("error", reject);
  });
  const seen: any[] = [];
  let n = 0;
  const s = setup({
    reply: async (o) => {
      if (++n === 1) {
        seen.push((statSync(sock).mode & 0o777).toString(8));
        seen.push(await ask({ method: "status" }));
        seen.push(await ask({ method: "steer", label: "w1", text: "use the f150 band" }));
        seen.push(await ask({ method: "steer", label: "nobody", text: "x" }));
        seen.push(await ask({ method: "stop" }));
        return { tool_calls: [{ index: 0, id: "c1", function: { name: "grep", arguments: "{}" } }] };
      }
      seen.push(o.messages.some(m => m.role === "user" && String(m.content).includes("f150")));
      return { content: "done" };
    },
    before: (h) => h.define("run:config", () => ({ base: dir, control: "c.sock" })),
  });
  try {
    userWf(s, "ctl.ts", 'export default async ({ run }) => run({ task: "t", tools: ["grep"], label: "w1" });\n');
    const r = await s.exec("run_workflow", { name: "ctl" });
    assert.equal(body(r), "done");
    const [mode, status, steer, missing, stop, delivered] = seen;
    assert.equal(mode, "600");
    assert.equal(status.ok, true);
    assert.deepEqual(status.agents.map((a: any) => [a.label, a.state]), [["w1", "working"]]);
    assert.deepEqual(steer, { ok: true, queued: [1] });
    assert.match(missing.error, /no running agent labelled nobody \(running: w1\)/);
    assert.match(stop.error, /offers status and steer/);
    assert.equal(delivered, true);
    assert.equal(existsSync(sock), false);
  } finally { s.cleanup(); rmSync(dir, { recursive: true, force: true }); }
});

test("provider:model ids: split only when the prefix is a provider the backend resolves; an explicit provider wins", async () => {
  const { splitProviderModel } = await import("../../examples/extensions/subagents/models.js");
  const known = (p: string) => p === "flatiron" || p === "codex";
  assert.deepEqual(splitProviderModel({ model: "flatiron:moonshotai/Kimi-K3" }, known), { model: "moonshotai/Kimi-K3", provider: "flatiron" });
  assert.deepEqual(splitProviderModel({ model: "codex:gpt-6-luna", thinking: "max" } as any, known), { model: "gpt-6-luna", provider: "codex", thinking: "max" });
  assert.deepEqual(splitProviderModel({ model: "llama3:8b" }, known), { model: "llama3:8b" });
  assert.deepEqual(splitProviderModel({ model: "org/model:tag" }, known), { model: "org/model:tag" });
  assert.deepEqual(splitProviderModel({ model: "codex:gpt-6-luna", provider: "other" }, known), { model: "codex:gpt-6-luna", provider: "other" });
  assert.deepEqual(splitProviderModel({ model: "plain" }, known), { model: "plain" });
});

test("roles: settings and config.roles give model and thinking; explicit model wins; unknown roles are refused", async () => {
  const { readFileSync, readdirSync } = await import("node:fs");
  const s = setup({
    reply: () => ({ content: "ok" }), usage: 5,
    settings: { roles: { worker: { model: "m-worker", thinking: "high" }, reviewer: { model: "m-old" } } },
    before: (h) => h.define("run:config", () => ({ base: "/", roles: { reviewer: { model: "m-reviewer" } } })),
  });
  try {
    userWf(s, "roles.ts", [
      "export default async ({ run }) => {",
      '  await run({ task: "a", tools: [], role: "worker" });',
      '  await run({ task: "b", tools: [], role: "reviewer" });',
      '  await run({ task: "c", tools: [], role: "worker", model: "m-explicit" });',
      '  try { await run({ task: "d", tools: [], role: "nobody" }); return "ran"; } catch (e) { return String(e.message); }',
      "};",
    ].join("\n"));
    const r = await s.exec("run_workflow", { name: "roles" });
    assert.match(body(r), /unknown role "nobody" \(roles: worker, reviewer\)/);
    const id = String(r.content).match(/\(workflow run (\S+);/)![1]!;
    const dir = join(s.root, "workflow-runs", id, "agents");
    const models = readdirSync(dir).sort().map(f => readFileSync(join(dir, f), "utf8").split("\n").filter(Boolean)
      .map(l => JSON.parse(l)).find(l => l.type === "request")?.model);
    assert.deepEqual(models.slice(0, 3), ["m-worker", "m-reviewer", "m-explicit"]);
  } finally { s.cleanup(); }
});
