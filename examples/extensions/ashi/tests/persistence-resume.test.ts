import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MultiSessionStore } from "../src/multi-session-store.js";
import { registerCapture } from "../src/capture.js";
import { applyBranchMessages } from "../src/commands.js";
import { resumeSession } from "../src/session-commands.js";

type Msg = { role: string; content: string };

/** Minimal ctx wiring the conversation handlers + a tiny bus, enough to drive
 *  capture/resume the way the real frontend does. */
function makeCtx(conv: { messages: Msg[] }) {
  const handlers = new Map<string, ((p?: unknown) => unknown)[]>();
  const bus = {
    on: (ev: string, fn: (p?: unknown) => unknown) => {
      const list = handlers.get(ev) ?? [];
      list.push(fn);
      handlers.set(ev, list);
    },
    emit: async (ev: string, payload?: unknown) => {
      for (const fn of handlers.get(ev) ?? []) await fn(payload);
    },
  };
  const ctx = {
    bus,
    call: (name: string, arg?: unknown) => {
      if (name === "conversation:get-messages") return conv.messages;
      if (name === "conversation:replace-messages") { conv.messages = arg as Msg[]; return; }
      return undefined;
    },
  };
  return { ctx, bus };
}

function seededSession(dir: string, cwd: string): Promise<string> {
  const store = new MultiSessionStore(dir, cwd);
  return store.current()
    .appendMessages([{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }] as never)
    .then(() => store.current().id);
}

test("a new turn in a session resumed via -c is persisted to disk", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ashi-persist-"));
  const cwd = "/tmp/ashi-persist-cwd";
  const sid = await seededSession(dir, cwd);

  // Fresh launch resuming that session (the `ashi -c` path).
  const store = new MultiSessionStore(dir, cwd, { resumeSessionId: sid });
  const conv = { messages: [] as Msg[] };
  const { ctx } = makeCtx(conv);
  const capture = registerCapture(ctx as never, () => store);
  applyBranchMessages(ctx as never, () => store, capture);
  assert.equal(conv.messages.length, 2, "resumed conversation should have the 2 prior messages");

  // A new turn: the agent appends a user + assistant message.
  conv.messages.push({ role: "user", content: "make a file" });
  conv.messages.push({ role: "assistant", content: "created it" });
  await capture.flush();

  const reread = new MultiSessionStore(dir, cwd, { resumeSessionId: sid }).current().buildMessages();
  assert.equal(reread.length, 4, "the new turn should be on disk after flush");
  assert.equal((reread[3] as Msg).content, "created it");
});

test("concurrent flushes do not double-append (serialized)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ashi-persist-"));
  const cwd = "/tmp/ashi-persist-cwd-conc";
  const store = new MultiSessionStore(dir, cwd);
  const conv = { messages: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }] as Msg[] };
  const { ctx } = makeCtx(conv);
  const capture = registerCapture(ctx as never, () => store);

  // A processing-done flush and an exit-cleanup flush racing each other.
  await Promise.all([capture.flush(), capture.flush()]);

  const reread = new MultiSessionStore(dir, cwd, { resumeSessionId: store.current().id }).current().buildMessages();
  assert.equal(reread.length, 2, "the two messages should be appended exactly once, not duplicated");
});

test("the exit race: processing-done leaves the turn un-persisted until flush is awaited", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ashi-persist-"));
  const cwd = "/tmp/ashi-persist-cwd-race";
  const sid = await seededSession(dir, cwd);

  const store = new MultiSessionStore(dir, cwd, { resumeSessionId: sid });
  const conv = { messages: [] as Msg[] };
  const { ctx, bus } = makeCtx(conv);
  const capture = registerCapture(ctx as never, () => store);
  applyBranchMessages(ctx as never, () => store, capture);

  // A turn completes: the agent appended user + assistant messages.
  conv.messages.push({ role: "user", content: "make+edit a file" });
  conv.messages.push({ role: "assistant", content: "did it" });

  const file = path.join(dir, `${sid}.jsonl`);
  const onDisk = (): number =>
    fs.readFileSync(file, "utf8").split("\n").filter((l) => l.includes('"type":"message"')).length;

  assert.equal(onDisk(), 2, "before the turn flushes, only the 2 seeded messages are on disk");

  // The real listener does `void flush()` — fire-and-forget, no await.
  await bus.emit("agent:processing-done");

  // The race window: a bare process.exit() here (old behavior) loses the turn.
  assert.equal(onDisk(), 2, "the new turn is NOT on disk yet — a bare process.exit() here loses it");

  await capture.flush();
  assert.equal(onDisk(), 4, "awaiting the pending flush on exit persists the turn");
});

test("seeding before the agent backend is active throws instead of silently dropping resumed turns", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ashi-persist-"));
  const cwd = "/tmp/ashi-persist-cwd-order";
  const sid = await seededSession(dir, cwd);

  const store = new MultiSessionStore(dir, cwd, { resumeSessionId: sid });

  const handlers = new Map<string, (p?: unknown) => unknown>();
  const ctx = { bus: { on() {}, emit() {} }, call: (n: string, a?: unknown) => handlers.get(n)?.(a) };
  const capture = registerCapture(ctx as never, () => store);

  assert.throws(
    () => applyBranchMessages(ctx as never, () => store, capture),
    /conversation not seeded/,
  );
});

test("a new turn in a session resumed via the in-app picker is persisted", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ashi-persist-"));
  const cwd = "/tmp/ashi-persist-cwd2";
  const sid = await seededSession(dir, cwd);

  // Launch creates a fresh session; then resume the seeded one in-app.
  const store = new MultiSessionStore(dir, cwd);
  const conv = { messages: [] as Msg[] };
  const { ctx } = makeCtx(conv);
  const capture = registerCapture(ctx as never, () => store);
  resumeSession(ctx as never, () => store, capture, sid);
  assert.equal(store.current().id, sid, "current session should be the resumed one");
  assert.equal(conv.messages.length, 2);

  conv.messages.push({ role: "user", content: "edit it" });
  conv.messages.push({ role: "assistant", content: "edited" });
  await capture.flush();

  const reread = new MultiSessionStore(dir, cwd, { resumeSessionId: sid }).current().buildMessages();
  assert.equal(reread.length, 4, "the new turn should be on disk after flush");
});

test("scheme-bridged edits persist their diff under the enclosing scheme_eval call", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ashi-persist-"));
  const cwd = "/tmp/ashi-persist-scheme";
  const store = new MultiSessionStore(dir, cwd);
  const conv = { messages: [] as Msg[] };
  const { ctx, bus } = makeCtx(conv);
  const capture = registerCapture(ctx as never, () => store);

  await bus.emit("agent:tool-started", { toolCallId: "call_1", name: "scheme_eval", title: "scheme" });
  await bus.emit("agent:tool-started", { toolCallId: "scheme-edit_file-1", title: "edit_file" });
  await bus.emit("agent:tool-completed", {
    toolCallId: "scheme-edit_file-1", exitCode: 0,
    resultDisplay: { body: { kind: "diff", filePath: "/x/a.ts",
      diff: { added: 3, removed: 1, isNewFile: false, isIdentical: false, hunks: [] } } },
  });
  await bus.emit("agent:tool-completed", { toolCallId: "call_1", exitCode: 0 });

  conv.messages.push({
    role: "assistant", content: "",
    tool_calls: [{ id: "call_1", type: "function", function: { name: "scheme_eval", arguments: "(edit-file ...)" } }],
  } as never);
  conv.messages.push({ role: "tool", tool_call_id: "call_1", content: "ok" } as never);
  await capture.flush();

  const branch = new MultiSessionStore(dir, cwd, { resumeSessionId: store.current().id }).current().getBranch();
  const toolMsg = branch
    .filter((e) => e.type === "message")
    .map((e) => (e as { message: { role: string; tool_call_id?: string; meta?: { diffs?: unknown[] } } }).message)
    .find((m) => m.role === "tool" && m.tool_call_id === "call_1");
  assert.ok(toolMsg, "scheme_eval tool result persisted");
  const diffs = toolMsg!.meta?.diffs as Array<{ name: string; filePath: string }> | undefined;
  assert.ok(Array.isArray(diffs) && diffs.length === 1, "nested edit diff bucketed onto the scheme_eval tool message");
  assert.equal(diffs![0].name, "edit_file");
  assert.equal(diffs![0].filePath, "/x/a.ts");
});

test("a tool's call-line summary is persisted for resume (any tool, not just diffs)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ashi-persist-"));
  const cwd = "/tmp/ashi-persist-summary";
  const store = new MultiSessionStore(dir, cwd);
  const conv = { messages: [] as Msg[] };
  const { ctx, bus } = makeCtx(conv);
  const capture = registerCapture(ctx as never, () => store);

  await bus.emit("agent:tool-started", { toolCallId: "call_x", name: "bash", title: "bash" });
  await bus.emit("agent:tool-completed", { toolCallId: "call_x", exitCode: 0, resultDisplay: { summary: "0.3s" } });

  conv.messages.push({
    role: "assistant", content: "",
    tool_calls: [{ id: "call_x", type: "function", function: { name: "bash", arguments: "ls" } }],
  } as never);
  conv.messages.push({ role: "tool", tool_call_id: "call_x", content: "out" } as never);
  await capture.flush();

  const branch = new MultiSessionStore(dir, cwd, { resumeSessionId: store.current().id }).current().getBranch();
  const toolMsg = branch
    .filter((e) => e.type === "message")
    .map((e) => (e as { message: { role: string; meta?: { summary?: string } } }).message)
    .find((m) => m.role === "tool");
  assert.ok(toolMsg, "tool result persisted");
  assert.equal(toolMsg!.meta?.summary, "0.3s", "the bash summary is persisted for resume");
});
