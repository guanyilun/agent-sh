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

  // A new turn: the agent appends a user + assistant message, then completes.
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
