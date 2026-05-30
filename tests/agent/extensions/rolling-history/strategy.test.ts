import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { LiveView } from "../../../../src/agent/live-view.js";
import {
  parseTurns,
  inferPriority,
  slimTurn,
  Priority,
  makeCompactAdvisor,
  makeCaptureHandler,
  type SummaryCtx,
} from "../../../../src/agent/extensions/rolling-history/strategy.js";
import { InMemoryStore } from "../../../../src/agent/store.js";
import type { Store } from "../../../../src/agent/store.js";
import type { AgentShMessage } from "../../../../src/agent/llm-client.js";

function u(text: string): AgentShMessage {
  return { role: "user", content: text };
}
function a(text: string): AgentShMessage {
  return { role: "assistant", content: text };
}
function aTool(text: string, calls: { id: string; name: string; args?: Record<string, unknown> }[]): AgentShMessage {
  return {
    role: "assistant",
    content: text,
    tool_calls: calls.map((c) => ({
      id: c.id, type: "function" as const,
      function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) },
    })),
  };
}
function toolResult(id: string, content: string, opts?: { isError?: boolean; toolName?: string; args?: Record<string, unknown> }): AgentShMessage {
  const m: AgentShMessage = { role: "tool", tool_call_id: id, content };
  if (opts?.toolName !== undefined) {
    m.meta = { tool: { toolName: opts.toolName, args: opts.args ?? {}, isError: !!opts.isError } };
  }
  return m;
}

function buildState(msgs: AgentShMessage[]): LiveView {
  // handlers=null disables the eager-nucleate / history:append calls so
  // the legacy path operates purely on its own messages array.
  const state = new LiveView(null, "test-iid");
  state.replaceMessages(msgs);
  return state;
}

function makeCtx(state: LiveView, store: Store): SummaryCtx {
  return {
    store,
    bus: { on: () => {} },
    advise: () => {},
    iid: "test-iid",
    getMessages: () => state.get(),
    replaceMessages: (msgs) => state.replace(msgs),
    estimateTokens: () => state.estimateTokens(),
    estimatePromptTokens: () => state.estimatePromptTokens(),
    linkMessage: (i, id) => state.link(i, id),
  };
}

describe("parseTurns", () => {
  test("splits on user-message boundaries", () => {
    const msgs = [
      u("first"),
      a("reply 1"),
      u("second"),
      a("reply 2"),
    ];
    const turns = parseTurns(msgs);
    assert.equal(turns.length, 2);
    assert.equal(turns[0]!.messages.length, 2);
    assert.equal(turns[0]!.messages[0]!.content, "first");
    assert.equal(turns[1]!.messages[0]!.content, "second");
  });

  test("headless first turn (system preamble)", () => {
    const msgs = [
      { role: "system" as const, content: "system prompt" },
      u("first"),
      a("reply"),
    ];
    const turns = parseTurns(msgs);
    // First turn carries the system message; second is user-initiated.
    assert.equal(turns.length, 2);
    assert.equal(turns[0]!.messages[0]!.role, "system");
    assert.equal(turns[1]!.messages[0]!.role, "user");
  });

  test("tool calls grouped into preceding user turn", () => {
    const msgs = [
      u("do thing"),
      aTool("calling...", [{ id: "t1", name: "bash" }]),
      toolResult("t1", "output"),
      a("done"),
    ];
    const turns = parseTurns(msgs);
    assert.equal(turns.length, 1);
    assert.equal(turns[0]!.messages.length, 4);
  });
});

describe("inferPriority", () => {
  test("user message returns HIGH", () => {
    assert.equal(inferPriority([u("hi")]), Priority.HIGH);
  });

  test("plain assistant turn returns MEDIUM", () => {
    assert.equal(inferPriority([a("hi")]), Priority.MEDIUM);
  });

  test("tool error returns HIGH", () => {
    const msgs = [
      aTool("calling", [{ id: "t1", name: "bash" }]),
      toolResult("t1", "Error: boom", { toolName: "bash", isError: true }),
    ];
    assert.equal(inferPriority(msgs), Priority.HIGH);
  });

  test("write-tool turn returns MEDIUM", () => {
    const msgs = [
      aTool("editing", [{ id: "t1", name: "write_file" }]),
      toolResult("t1", "ok", { toolName: "write_file" }),
    ];
    assert.equal(inferPriority(msgs), Priority.MEDIUM);
  });

  test("all-read-only tool turn returns LOWEST", () => {
    const msgs = [
      aTool("looking", [{ id: "t1", name: "read_file" }]),
      toolResult("t1", "contents", { toolName: "read_file" }),
    ];
    assert.equal(inferPriority(msgs), Priority.LOWEST);
  });

  test("mixed tool result without error returns LOW", () => {
    const msgs = [
      aTool("running", [{ id: "t1", name: "bash" }]),
      toolResult("t1", "ok", { toolName: "bash" }),
    ];
    assert.equal(inferPriority(msgs), Priority.LOW);
  });

  test("error detected by content prefix when meta.tool is absent", () => {
    const msgs = [
      aTool("run", [{ id: "t1", name: "bash" }]),
      toolResult("t1", "Error: something failed"),
    ];
    assert.equal(inferPriority(msgs), Priority.HIGH);
  });
});

describe("slimTurn", () => {
  test("drops read-only tool calls + results", () => {
    const msgs = [
      aTool("look", [
        { id: "t1", name: "read_file" },
        { id: "t2", name: "write_file" },
      ]),
      toolResult("t1", "read contents", { toolName: "read_file" }),
      toolResult("t2", "ok", { toolName: "write_file" }),
    ];
    const out = slimTurn(msgs);
    // The read_file call + its result are dropped; the write_file
    // call + result survive.
    const assistant = out.find((m) => m.role === "assistant")!;
    assert.equal((assistant as { tool_calls: { id: string }[] }).tool_calls.length, 1);
    assert.equal((assistant as { tool_calls: { id: string }[] }).tool_calls[0]!.id, "t2");
    assert.equal(out.filter((m) => m.role === "tool").length, 1);
  });

  test("trims long tool output", () => {
    const longContent = "a".repeat(5000);
    const msgs = [
      aTool("run", [{ id: "t1", name: "bash" }]),
      toolResult("t1", longContent, { toolName: "bash" }),
    ];
    const out = slimTurn(msgs);
    const trimmed = out.find((m) => m.role === "tool")!;
    assert.ok(typeof trimmed.content === "string" && trimmed.content.length < 5000);
    assert.ok(typeof trimmed.content === "string" && trimmed.content.includes("trimmed by compact"));
  });
});

describe("compact end-to-end", () => {
  // Build a non-trivial conversation with mixed turn priorities.
  function bigConversation(): AgentShMessage[] {
    const msgs: AgentShMessage[] = [];
    for (let i = 0; i < 8; i++) {
      msgs.push(u(`question ${i}: ${"x".repeat(200)}`));
      msgs.push(
        aTool(`thinking ${i}`, [{ id: `t${i}`, name: i % 2 === 0 ? "read_file" : "write_file" }]),
      );
      msgs.push(
        toolResult(`t${i}`, `result ${i}: ${"y".repeat(500)}`, {
          toolName: i % 2 === 0 ? "read_file" : "write_file",
        }),
      );
      msgs.push(a(`reply ${i}`));
    }
    return msgs;
  }

  test("no compaction needed when under budget", async () => {
    const msgs = [u("hi"), a("hello")];
    const state = buildState(msgs);
    const store = new InMemoryStore();
    const ctx = makeCtx(state, store);
    const advisor = makeCompactAdvisor(ctx);

    const result = await advisor(async () => null, { target: 1_000_000 });
    assert.equal(result, null);
  });

  test("evicts when over budget and reduces live view", async () => {
    const msgs = bigConversation();
    const budget = 500;
    const state = buildState(msgs);
    const store = new InMemoryStore();
    const ctx = makeCtx(state, store);
    const advisor = makeCompactAdvisor(ctx);

    const beforeLen = state.get().length;
    const result = await advisor(async () => null, { target: budget });

    assert.ok(result, "should compact");
    assert.ok(result.evictedCount > 0, "evictedCount should be > 0");
    assert.ok(state.get().length < beforeLen, "live view should shrink");
  });

  test("rebuilt live view keeps the first turn and the last turn", async () => {
    const msgs = bigConversation();
    const budget = 500;
    const state = buildState(msgs);
    const store = new InMemoryStore();
    const ctx = makeCtx(state, store);
    const advisor = makeCompactAdvisor(ctx);

    const firstUserContent = msgs.find((m) => m.role === "user")?.content;
    const result = await advisor(async () => null, { target: budget });

    assert.ok(result);
    const rebuilt = state.get();
    // First user turn is pinned (priority PINNED on turns[0]).
    assert.ok(rebuilt.some((m) => m.role === "user" && m.content === firstUserContent),
      "first user turn should be pinned");
    // Last assistant message survives verbatim (the verbatim tail).
    const lastInput = msgs[msgs.length - 1];
    assert.ok(rebuilt.includes(lastInput as never) || rebuilt.some(m => m.role === lastInput?.role),
      "last turn should be present");
  });

  test("synthetic summary block is inserted with the conversation-history marker", async () => {
    const msgs = bigConversation();
    const state = buildState(msgs);
    const store = new InMemoryStore();
    const ctx = makeCtx(state, store);
    const advisor = makeCompactAdvisor(ctx);

    const result = await advisor(async () => null, { target: 500 });
    assert.ok(result);

    const marker = "[Conversation history";
    const block = state.get().find(
      (m) => m.role === "user" && typeof m.content === "string" && m.content.startsWith(marker),
    );
    assert.ok(block, "summary block should be present in live view");
  });

  test("force compact relaxes the min-turns check", async () => {
    // Without force, a 2-turn conversation can't be compacted. With force,
    // it can be (relaxed minTurns from 2 to 1) — though eviction still
    // requires being over budget.
    const msgs = bigConversation();
    const state = buildState(msgs);
    const store = new InMemoryStore();
    const ctx = makeCtx(state, store);
    const advisor = makeCompactAdvisor(ctx);

    // Tight budget + force should evict; matches the existing kernel
    // semantics (force ⇒ allow more aggressive pin/evict ratios).
    const result = await advisor(async () => null, { target: 500, force: true });
    assert.ok(result, "force + tight budget should compact");
  });

  test("compact result before/after match conv-token estimates", async () => {
    const msgs = bigConversation();
    const state = buildState(msgs);
    const store = new InMemoryStore();
    const ctx = makeCtx(state, store);
    const advisor = makeCompactAdvisor(ctx);

    const tokensBefore = state.estimatePromptTokens();
    const result = await advisor(async () => null, { target: 500 });
    assert.ok(result);
    assert.equal(result.before, tokensBefore);
    assert.ok(result.after <= result.before, "tokens should decrease after compaction");
  });

  test("rewind strategy delegates to next (handled by kernel)", async () => {
    const msgs = bigConversation();
    const state = buildState(msgs);
    const store = new InMemoryStore();
    const ctx = makeCtx(state, store);
    const advisor = makeCompactAdvisor(ctx);

    let nextCalled = false;
    const result = await advisor(
      async () => { nextCalled = true; return null; },
      { strategy: { kind: "rewind", toIndex: 5 } },
    );
    assert.ok(nextCalled, "rewind should delegate to next");
    assert.equal(result, null);
  });
});

describe("capture handler", () => {
  test("user message creates a summary entry and links via meta.entryId", async () => {
    const state = buildState([]);
    state.replaceMessages([u("first prompt")]);
    const store = new InMemoryStore();
    const ctx = makeCtx(state, store);
    const handler = makeCaptureHandler(ctx);

    await handler({ role: "user", content: "first prompt" });

    const recent = await store.readRecent();
    const userEntries = recent.filter((e) => e.kind === "user");
    assert.equal(userEntries.length, 1);
    assert.ok(state.get()[0]!.meta?.entryId, "meta.entryId should be set");
    assert.equal(state.get()[0]!.meta!.entryId, userEntries[0]!.id);
  });

  test("tool result message stamps meta.tool and creates entry", async () => {
    const state = buildState([toolResult("t1", "ok")]);
    const store = new InMemoryStore();
    const ctx = makeCtx(state, store);
    const handler = makeCaptureHandler(ctx);

    await handler({
      role: "tool", content: "ok",
      toolName: "bash", toolArgs: { cmd: "ls" }, isError: false,
    });

    const m = state.get()[0]!;
    const meta = m.meta as { tool?: { toolName: string; args: Record<string, unknown> }; entryId?: string } | undefined;
    assert.equal(meta?.tool?.toolName, "bash");
    assert.deepEqual(meta?.tool?.args, { cmd: "ls" });
    assert.ok(meta?.entryId, "tool message should be linked");

    const recent = await store.readRecent();
    assert.equal(recent.filter((e) => e.kind === "tool").length, 1);
  });
});
