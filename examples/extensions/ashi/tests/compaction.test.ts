import test from "node:test";
import assert from "node:assert/strict";
import { findCutPoint, isSafeCutPoint, estimateMessageTokens, pickBudget } from "../src/compaction.js";
import type { AgentShMessage as AgentMessage } from "agent-sh/session-store";

const userMsg = (text: string): AgentMessage => ({ role: "user", content: text });
const assistantMsg = (text: string): AgentMessage => ({ role: "assistant", content: text });
const assistantCall = (callId: string, name: string, args = ""): AgentMessage => ({
  role: "assistant",
  content: "",
  tool_calls: [{ id: callId, type: "function", function: { name, arguments: args } }],
});
const toolResult = (callId: string, text: string): AgentMessage => ({
  role: "tool",
  tool_call_id: callId,
  content: text,
});

test("estimateMessageTokens uses 0.25 chars/token + 20 overhead", () => {
  assert.equal(estimateMessageTokens(userMsg("abcd")), Math.ceil(4 * 0.25) + 20);
  assert.equal(estimateMessageTokens(userMsg("")), 20);
});

test("estimateMessageTokens includes tool_call arguments length", () => {
  const m = assistantCall("c1", "read_file", "x".repeat(40));
  assert.equal(estimateMessageTokens(m), Math.ceil(40 * 0.25) + 20);
});

test("isSafeCutPoint rejects tool result positions", () => {
  const msgs = [userMsg("hi"), assistantCall("c1", "read_file"), toolResult("c1", "ok")];
  assert.equal(isSafeCutPoint(msgs, 2), false);
});

test("isSafeCutPoint rejects assistant-with-tool-calls positions", () => {
  const msgs = [userMsg("hi"), assistantCall("c1", "read_file"), toolResult("c1", "ok")];
  assert.equal(isSafeCutPoint(msgs, 1), false);
});

test("isSafeCutPoint accepts plain user/assistant positions", () => {
  const msgs = [userMsg("hi"), assistantMsg("hello"), userMsg("again")];
  assert.equal(isSafeCutPoint(msgs, 0), true);
  assert.equal(isSafeCutPoint(msgs, 1), true);
  assert.equal(isSafeCutPoint(msgs, 2), true);
});

test("findCutPoint returns 0 when total tokens < budget", () => {
  const msgs = [userMsg("hi"), assistantMsg("hello")];
  assert.equal(findCutPoint(msgs, 10_000), 0);
});

test("findCutPoint walks back-to-front and lands on the budget-crossing message", () => {
  const big = "x".repeat(800); // ~200 tokens each
  const msgs: AgentMessage[] = [
    userMsg(big),       // idx 0
    assistantMsg(big),  // idx 1
    userMsg(big),       // idx 2
    assistantMsg(big),  // idx 3
  ];
  const cut = findCutPoint(msgs, 500);
  assert.ok(cut >= 1 && cut <= 2, `expected cut in [1,2], got ${cut}`);
});

test("pickBudget defaults to 20k when no force or target", () => {
  assert.equal(pickBudget(undefined), 20_000);
  assert.equal(pickBudget({}), 20_000);
});

test("pickBudget returns tight 4k budget when force=true", () => {
  assert.equal(pickBudget({ force: true }), 4_000);
  assert.equal(pickBudget({ force: true, target: 50_000 }), 4_000);
});

test("pickBudget clamps target up to the 4k minimum", () => {
  assert.equal(pickBudget({ target: 1000 }), 4_000);
  assert.equal(pickBudget({ target: 0 }), 20_000);
  assert.equal(pickBudget({ target: 37_500 }), 37_500);
});

test("findCutPoint snaps forward past an unsafe cut (tool result)", () => {
  const big = "x".repeat(800);
  const msgs: AgentMessage[] = [
    userMsg(big),                          // 0
    assistantCall("c1", "read_file", big), // 1 — unsafe
    toolResult("c1", big),                 // 2 — unsafe
    userMsg("ok"),                         // 3 — safe landing
  ];
  const cut = findCutPoint(msgs, 100);
  assert.equal(cut, 3, "must snap past the tool_call/tool_result pair");
});
