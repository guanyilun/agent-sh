import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
  SessionStore,
  type AgentMessage,
} from "../../examples/extensions/ashi/src/session-store.js";

function tmpFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ashi-session-"));
  return path.join(dir, "session.jsonl");
}

function u(text: string): AgentMessage {
  return { role: "user", content: text };
}
function a(text: string): AgentMessage {
  return { role: "assistant", content: text };
}

describe("SessionStore", () => {
  test("create + roundtrip: fresh store persists header and reloads with same id", async () => {
    const file = tmpFile();
    const created = new SessionStore(file, { create: { cwd: "/x", sessionId: "sess-1" } });
    await created.appendMessages([u("hello"), a("hi")]);

    const reloaded = new SessionStore(file);
    assert.equal(reloaded.id, "sess-1");
    assert.equal(reloaded.getRootId(), "sess-1");
    assert.equal(reloaded.entryCount(), 3); // header + 2 messages
  });

  test("appendMessages chains parentIds and advances the leaf", async () => {
    const file = tmpFile();
    const store = new SessionStore(file, { create: { cwd: "/x", sessionId: "s" } });
    const ids = await store.appendMessages([u("one"), a("two"), u("three")]);
    assert.equal(ids.length, 3);
    assert.equal(store.getActiveLeaf(), ids[2]);

    const branch = await store.getBranch();
    // [header, msg1, msg2, msg3] in oldest-first order
    assert.equal(branch.length, 4);
    assert.equal(branch[0]!.type, "session");
    assert.equal(branch[1]!.id, ids[0]);
    assert.equal(branch[2]!.id, ids[1]);
    assert.equal(branch[3]!.id, ids[2]);
  });

  test("buildMessages without compaction returns all messages in order", async () => {
    const file = tmpFile();
    const store = new SessionStore(file, { create: { cwd: "/x", sessionId: "s" } });
    await store.appendMessages([u("a"), a("b"), u("c")]);
    const msgs = await store.buildMessages();
    assert.deepEqual(msgs.map((m) => m.content), ["a", "b", "c"]);
  });

  test("buildMessages with compaction returns summary + tail from firstKeptId", async () => {
    const file = tmpFile();
    const store = new SessionStore(file, { create: { cwd: "/x", sessionId: "s" } });
    const ids = await store.appendMessages([u("q1"), a("a1"), u("q2"), a("a2"), u("q3")]);
    // Compact the first two turns; keep from id[2] onward.
    await store.appendCompaction("Summary of q1/a1/q2/a2", ids[2]!, 1000);

    const msgs = await store.buildMessages();
    // First message is the synthetic summary, then q2/a2/q3 from firstKeptId
    assert.equal(msgs.length, 4);
    assert.match(msgs[0]!.content as string, /^\[Compacted conversation summary\]/);
    assert.equal(msgs[1]!.content, "q2");
    assert.equal(msgs[2]!.content, "a2");
    assert.equal(msgs[3]!.content, "q3");
  });

  test("forking: setActiveLeaf rewinds and subsequent appends branch", async () => {
    const file = tmpFile();
    const store = new SessionStore(file, { create: { cwd: "/x", sessionId: "s" } });
    const trunk = await store.appendMessages([u("q1"), a("a1"), u("q2"), a("a2")]);

    // Rewind to after q1/a1.
    store.setActiveLeaf(trunk[1]!);
    const branchIds = await store.appendMessages([u("alt-q2"), a("alt-a2")]);

    const branchAfterRewind = await store.getBranch();
    const tail = branchAfterRewind.slice(-2).map((e) => e.id);
    assert.deepEqual(tail, branchIds);
  });

  test("getPreview returns first user message", async () => {
    const file = tmpFile();
    const store = new SessionStore(file, { create: { cwd: "/x", sessionId: "s" } });
    await store.appendMessages([a("first reply"), u("here is the question")]);
    const preview = await store.getPreview();
    assert.equal(preview, "here is the question");
  });

  test("setName persists across reload", async () => {
    const file = tmpFile();
    const created = new SessionStore(file, { create: { cwd: "/x", sessionId: "s" } });
    await created.appendMessages([u("hi")]);
    created.setName("named session");

    const reloaded = new SessionStore(file);
    assert.equal(reloaded.getMeta().name, "named session");
  });

  test("appendCompaction with unknown firstKeptId throws", async () => {
    const file = tmpFile();
    const store = new SessionStore(file, { create: { cwd: "/x", sessionId: "s" } });
    await store.appendMessages([u("hi")]);
    await assert.rejects(
      () => store.appendCompaction("summary", "no-such-id", 100),
      /firstKeptId unknown/,
    );
  });

  test("opening a session file with no header throws", () => {
    const file = tmpFile();
    fs.writeFileSync(file, "");
    assert.throws(() => new SessionStore(file), /lacks a session header/);
  });
});
