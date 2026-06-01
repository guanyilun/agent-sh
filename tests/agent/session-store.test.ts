import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fsp from "node:fs/promises";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { SessionStore, summarizeMessage } from "../../src/agent/session-store.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "session-store-test-"));
});

afterEach(async () => {
  try { await fsp.rm(tmpDir, { recursive: true, force: true }); } catch {}
});

describe("SessionStore", () => {
  test("writes JSONL header + entries and reads back round-trip", async () => {
    const file = path.join(tmpDir, "session.jsonl");
    const s = new SessionStore(file, { create: { cwd: "/x", sessionId: "abc" } });
    await s.appendMessages([{ role: "user", content: "hi" }]);

    const reopened = new SessionStore(file);
    assert.equal(reopened.getRootId(), "abc");
    const branch = reopened.getBranch();
    assert.equal(branch.length, 2);
    assert.equal(branch[0]!.type, "session");
    assert.equal(branch[1]!.type, "message");
  });

  test("defers header write until the first append", async () => {
    const file = path.join(tmpDir, "deferred.jsonl");
    new SessionStore(file, { create: { cwd: "/x", sessionId: "id1" } });
    assert.equal(fs.existsSync(file), false, "no file before first append");
  });

  test("getBranch walks parentId from leaf back to root", async () => {
    const file = path.join(tmpDir, "branch.jsonl");
    const s = new SessionStore(file, { create: { cwd: "/x", sessionId: "root" } });
    const [a, b, c] = await s.appendMessages([
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "user", content: "c" },
    ]);
    const branch = s.getBranch();
    assert.deepEqual(branch.map((e) => e.id), ["root", a, b, c]);
  });

  test("forks: setting activeLeaf to a mid-branch entry rewinds, next append branches", async () => {
    const file = path.join(tmpDir, "fork.jsonl");
    const s = new SessionStore(file, { create: { cwd: "/x", sessionId: "root" } });
    const [a, b] = await s.appendMessages([
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
    ]);
    // Rewind to `a` and write a divergent child.
    s.setActiveLeaf(a!);
    const [aPrime] = await s.appendMessages([{ role: "assistant", content: "b-prime" }]);
    // Branch A still walks through original `b`.
    assert.deepEqual(s.getBranch(b!).map((e) => e.id), ["root", a, b]);
    // Branch A' walks through the divergent child.
    assert.deepEqual(s.getBranch(aPrime!).map((e) => e.id), ["root", a, aPrime]);
  });

  test("buildMessages honors latest compaction: summary stub + kept tail", async () => {
    const file = path.join(tmpDir, "compact.jsonl");
    const s = new SessionStore(file, { create: { cwd: "/x", sessionId: "root" } });
    const ids = await s.appendMessages([
      { role: "user", content: "first" },
      { role: "assistant", content: "reply 1" },
      { role: "user", content: "kept" },
      { role: "assistant", content: "reply 2" },
    ]);
    await s.appendCompaction(ids[2]!, 1000, "elided 2 messages");

    const built = s.buildMessages();
    assert.equal(built.length, 3);
    assert.equal(built[0]!.role, "user");
    assert.match(built[0]!.content as string, /elided 2 messages/);
    assert.equal(built[1]!.content, "kept");
    assert.equal(built[2]!.content, "reply 2");
  });

  test("buildMessages with no stored summary renders one from evicted messages", async () => {
    const file = path.join(tmpDir, "compact-nosum.jsonl");
    const s = new SessionStore(file, { create: { cwd: "/x", sessionId: "root" } });
    const ids = await s.appendMessages([
      { role: "user", content: "ancient question" },
      { role: "user", content: "kept" },
    ]);
    await s.appendCompaction(ids[1]!, 100);

    const built = s.buildMessages();
    assert.match(built[0]!.content as string, /ancient question/);
  });

  test("shell-exchange entries are stored but excluded from buildMessages", async () => {
    const file = path.join(tmpDir, "shell.jsonl");
    const s = new SessionStore(file, { create: { cwd: "/x", sessionId: "root" } });
    await s.appendMessages([{ role: "user", content: "hi" }]);
    await s.appendShellExchange({ command: "ls", output: "a b c", exitCode: 0 });
    await s.appendMessages([{ role: "assistant", content: "done" }]);

    assert.equal(s.getAllEntries().filter((e) => e.type === "shell-exchange").length, 1);
    const built = s.buildMessages();
    assert.equal(built.length, 2);
    assert.equal(built[0]!.content, "hi");
    assert.equal(built[1]!.content, "done");
  });

  test("getPreview returns first user message, stripping context wrappers", async () => {
    const file = path.join(tmpDir, "preview.jsonl");
    const s = new SessionStore(file, { create: { cwd: "/x", sessionId: "root" } });
    await s.appendMessages([
      { role: "user", content: "<query_context>noise</query_context>real question here" },
    ]);
    assert.equal(s.getPreview(), "real question here");
  });

  test("getPreview collapses newlines so the resume picker stays single-line", async () => {
    const file = path.join(tmpDir, "preview-multiline.jsonl");
    const s = new SessionStore(file, { create: { cwd: "/x", sessionId: "root" } });
    await s.appendMessages([
      { role: "user", content: "incorporate this as an extension?\n\n   Lev Landau's mentor said" },
    ]);
    const preview = s.getPreview();
    assert.ok(!preview.includes("\n"), "no embedded newlines");
    assert.equal(preview, "incorporate this as an extension? Lev Landau's mentor said");
  });

  test("summarizeMessage formats roles distinctively", () => {
    assert.match(summarizeMessage({ role: "user", content: "hello" }), /^user: hello/);
    assert.match(summarizeMessage({ role: "tool", content: "result" }), /^tool result:/);
    assert.match(
      summarizeMessage({
        role: "assistant",
        content: null,
        tool_calls: [{ id: "1", type: "function", function: { name: "bash", arguments: "{}" } }],
      } as Parameters<typeof summarizeMessage>[0]),
      /called bash/,
    );
  });

  test("throws if reopened without a session header", async () => {
    const file = path.join(tmpDir, "broken.jsonl");
    await fsp.writeFile(file, '{"type":"message","id":"x","parentId":"none","timestamp":0,"message":{"role":"user","content":"oops"}}\n');
    assert.throws(() => new SessionStore(file), /lacks a session header/);
  });
});
