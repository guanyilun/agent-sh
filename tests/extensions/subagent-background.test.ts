/** Background subagent runs: status in dynamic context, results via subagent_jobs, wake only when idle. */
import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { lastUser, setup } from "./subagents-harness.js";

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((r) => { open = r; });
  return { open, opened };
}
const tick = (ms = 150) => new Promise((r) => setTimeout(r, ms));
const pending = (s: ReturnType<typeof setup>) => s.bus.emitPipe("agent:pending-work", { count: 0 }).count;

function steers(s: ReturnType<typeof setup>) {
  const out: string[] = [];
  s.bus.on("agent:steer", (e) => { out.push(e.text); });
  return out;
}

test("a background run returns at once, shows status in context, and hands its result over once", async () => {
  const g = gate();
  const s = setup({ reply: async (o) => { await g.opened; return { content: `result for ${lastUser(o)}` }; } });
  try {
    const started = await s.run({ agent: "scout", task: "map it", background: true });
    assert.match(String(started.content), /^Started background run #1 \(scout\)/);
    assert.match(s.context("background-subagents")!, /#1 scout: running \d+s/);
    assert.equal(pending(s), 1);

    g.open();
    await tick(20);
    assert.match(s.context("background-subagents")!, /#1 scout: done, unread/);

    const r = await s.exec("subagent_jobs", { action: "result", id: 1 });
    assert.match(String(r.content), /^Run #1 \(scout\) done after \d+s:\n\nresult for map it$/);
    assert.equal(s.context("background-subagents"), null);
  } finally { s.cleanup(); }
});

test("an idle agent is woken with a short note that carries no subagent text", async () => {
  const s = setup({ reply: () => ({ content: "SECRET RESULT TEXT" }) });
  try {
    const notes = steers(s);
    await s.run({ agent: "scout", task: "a", background: true });
    await tick();
    assert.deepEqual(notes, ["[background] Finished: #1 scout (done). Read the result with subagent_jobs."]);
    assert.equal(pending(s), 0);
    await tick();
    assert.equal(notes.length, 1);
  } finally { s.cleanup(); }
});

test("a busy agent isn't interrupted; it's woken at the end of its turn only if it didn't read the result", async () => {
  const s = setup({ reply: () => ({ content: "r" }) });
  try {
    const notes = steers(s);
    s.bus.emit("agent:processing-start", {});
    await s.run({ agent: "scout", task: "a", background: true });
    await s.run({ agent: "scout", task: "b", background: true });
    await tick();
    assert.deepEqual(notes, []);
    assert.equal(pending(s), 2);

    await s.exec("subagent_jobs", { action: "result", id: 1 });
    s.bus.emit("agent:processing-done", {});
    await tick();
    assert.deepEqual(notes, ["[background] Finished: #2 scout (done). Read the result with subagent_jobs."]);
  } finally { s.cleanup(); }
});

test("with backgroundWake off, finishing shows a notice and isn't pending work", async () => {
  const s = setup({ reply: () => ({ content: "r" }), settings: { backgroundWake: false } });
  try {
    const notes = steers(s);
    const infos: string[] = [];
    s.bus.on("ui:info", (e) => { infos.push(e.message); });
    await s.run({ agent: "scout", task: "a", background: true });
    await tick();
    assert.deepEqual(notes, []);
    assert.match(infos.join("\n"), /Background run #1 \(scout\) done; the agent sees it on your next message/);
    assert.equal(pending(s), 0);
    assert.match(s.context("background-subagents")!, /done, unread/);
  } finally { s.cleanup(); }
});

test("wait blocks until a run finishes, and times out with what's still running", async () => {
  const g = gate();
  const s = setup({ reply: async () => { await g.opened; return { content: "late" }; } });
  try {
    await s.run({ agent: "scout", task: "a", background: true });
    let r = await s.exec("subagent_jobs", { action: "wait", timeoutSeconds: 0.05 });
    assert.match(String(r.content), /^Still running: #1 scout: running/);

    const waiting = s.exec("subagent_jobs", { action: "wait" });
    g.open();
    r = await waiting;
    assert.match(String(r.content), /^Run #1 \(scout\) done after \d+s:\n\nlate$/);
  } finally { s.cleanup(); }
});

test("cancel stops a run; a reset cancels and forgets everything", async () => {
  const g = gate();
  const s = setup({ reply: async () => { await g.opened; return { content: "never" }; } });
  try {
    const notes = steers(s);
    await s.run({ agent: "scout", task: "a", background: true });
    await s.run({ agent: "scout", task: "b", background: true });
    assert.equal((await s.exec("subagent_jobs", { action: "cancel", id: 1 })).content, "Cancelled #1.");
    assert.match(String((await s.exec("subagent_jobs", { action: "list" })).content), /#1 scout: cancelled, unread\n#2 scout: running/);

    s.bus.emit("agent:reset-session", {});
    g.open();
    await tick();
    assert.equal((await s.exec("subagent_jobs", { action: "list" })).content, "No background runs.");
    assert.equal(s.context("background-subagents"), null);
    assert.ok(notes.every(n => !n.includes("#2")), notes.join("\n"));
  } finally { s.cleanup(); }
});

test("background and foreground runs share one concurrency limit", async () => {
  const g = gate();
  const order: string[] = [];
  const s = setup({
    settings: { maxConcurrency: 1 },
    reply: async (o) => {
      const task = lastUser(o);
      order.push(`start ${task}`);
      if (task === "bg") await g.opened;
      order.push(`end ${task}`);
      return { content: task };
    },
  });
  try {
    await s.run({ agent: "scout", task: "bg", background: true });
    const fg = s.run({ agent: "scout", task: "fg" });
    await tick(20);
    assert.deepEqual(order, ["start bg"]);
    g.open();
    await fg;
    assert.deepEqual(order, ["start bg", "end bg", "start fg", "end fg"]);
  } finally { s.cleanup(); }
});

test("workflows run in the background too", async () => {
  const s = setup({ reply: () => ({ content: "r" }) });
  try {
    writeFileSync(join(s.root, "workflows", "quick.ts"), 'export default async ({ args }) => `quick ${args}`;\n');
    const started = await s.exec("run_workflow", { name: "quick", args: "x", background: true });
    assert.match(String(started.content), /^Started background run #1 \(workflow quick\)/);
    const r = await s.exec("subagent_jobs", { action: "wait", id: 1 });
    assert.match(String(r.content), /done after \d+s:\n\nquick x\n\n\(workflow run /);
  } finally { s.cleanup(); }
});
