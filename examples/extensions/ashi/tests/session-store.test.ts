import test, { after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import {
  SessionStore,
  renderEvictedSummary,
  summarizeMessage,
  type AgentMessage,
} from "../src/session-store.js";

const tmpDirs: string[] = [];
after(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

function tmpSessionPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ashi-store-"));
  tmpDirs.push(dir);
  return path.join(dir, "session.jsonl");
}

function makeStore(): SessionStore {
  return new SessionStore(tmpSessionPath(), {
    create: { cwd: process.cwd(), sessionId: crypto.randomBytes(4).toString("hex") },
  });
}

test("summarizeMessage renders user role with cap of 1000", () => {
  const m: AgentMessage = { role: "user", content: "what's in foo.ts?" };
  assert.equal(summarizeMessage(m), "user: what's in foo.ts?");
});

test("summarizeMessage truncates user content past the cap", () => {
  const long = "a".repeat(1500);
  const out = summarizeMessage({ role: "user", content: long });
  assert.match(out, /^user: a{1000}…$/);
});

test("summarizeMessage renders bare assistant text with cap of 500", () => {
  const m: AgentMessage = { role: "assistant", content: "thinking about it" };
  assert.equal(summarizeMessage(m), "assistant: thinking about it");
});

test("summarizeMessage renders assistant with tool calls and surfaces args", () => {
  const m: AgentMessage = {
    role: "assistant",
    content: "reading the file",
    tool_calls: [{ id: "c1", function: { name: "read_file", arguments: '{"path":"src/a.ts"}' } }],
  };
  const out = summarizeMessage(m);
  assert.match(out, /^assistant: reading the file → called read_file\(/);
  assert.match(out, /src\/a\.ts/);
});

test("summarizeMessage shows tool name without args when arguments empty", () => {
  const m: AgentMessage = {
    role: "assistant",
    content: "",
    tool_calls: [{ id: "c1", function: { name: "ls", arguments: "" } }],
  };
  assert.equal(summarizeMessage(m), "assistant: called ls");
});

test("summarizeMessage caps tool result text at 400 for success", () => {
  const m: AgentMessage = { role: "tool", tool_call_id: "c1", content: "ok " + "x".repeat(500) };
  const out = summarizeMessage(m);
  const body = out.replace(/^tool result: /, "");
  assert.ok(body.endsWith("…"));
  assert.ok(body.length <= 401, `body length ${body.length}`);
});

test("summarizeMessage caps tool result text at 1000 for errors", () => {
  const m: AgentMessage = { role: "tool", tool_call_id: "c1", content: "Error: " + "x".repeat(1200) };
  const out = summarizeMessage(m);
  const body = out.replace(/^tool result: /, "");
  assert.ok(body.length > 401, "error result should exceed the 400-char success cap");
  assert.ok(body.length <= 1001, `body length ${body.length}`);
});

test("renderEvictedSummary header reports count and one line per message", () => {
  const evicted: AgentMessage[] = [
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi" },
  ];
  const out = renderEvictedSummary(evicted);
  const lines = out.split("\n");
  assert.equal(lines[0], "2 message(s) elided");
  assert.equal(lines.length, 3);
  assert.equal(lines[1], "- user: hello");
  assert.equal(lines[2], "- assistant: hi");
});

test("renderEvictedSummary on empty input reports 0", () => {
  const out = renderEvictedSummary([]);
  assert.equal(out, "0 message(s) elided\n");
});

test("buildMessages without compaction returns raw messages", async () => {
  const store = makeStore();
  await store.appendMessages([
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello" },
  ]);
  const msgs = store.buildMessages();
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0]!.role, "user");
  assert.equal(msgs[1]!.role, "assistant");
});

test("buildMessages with compaction + stored summary uses the stored text", async () => {
  const store = makeStore();
  const [_evicted, kept] = await store.appendMessages([
    { role: "user", content: "old thing" },
    { role: "user", content: "kept thing" },
  ]);
  await store.appendCompaction(kept!, 100, "MY_CUSTOM_SUMMARY");
  const msgs = store.buildMessages();
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0]!.role, "user");
  assert.match(String(msgs[0]!.content), /MY_CUSTOM_SUMMARY/);
  assert.equal(msgs[1]!.content, "kept thing");
});

test("buildMessages with compaction + no summary regenerates via renderEvictedSummary", async () => {
  const store = makeStore();
  const [_oldest, _middle, kept] = await store.appendMessages([
    { role: "user", content: "first" },
    { role: "assistant", content: "second" },
    { role: "user", content: "kept" },
  ]);
  await store.appendCompaction(kept!, 100);
  const msgs = store.buildMessages();
  const expected = renderEvictedSummary([
    { role: "user", content: "first" },
    { role: "assistant", content: "second" },
  ]);
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0]!.content, `[Compacted conversation summary]\n${expected}`);
  assert.equal(msgs[1]!.content, "kept");
});

test("appendCompaction throws when firstKeptId is unknown", async () => {
  const store = makeStore();
  await assert.rejects(() => store.appendCompaction("nonexistent", 0));
});
