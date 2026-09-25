/** Subagent run metadata (outMeta) + reasoning-param forwarding. */
import test from "node:test";
import assert from "node:assert/strict";
import { runSubagent, type SubagentRunMeta } from "../../src/agent/subagent.js";
import type { LlmClient } from "../../src/agent/llm-client.js";
import type { ToolDefinition } from "../../src/agent/types.js";

type StreamOpts = Record<string, unknown>;
const USAGE = { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 };

/** Fake client: one assistant chunk per iteration, recording each call's opts. */
function fakeClient(calls: StreamOpts[], reply: () => Record<string, unknown>) {
  return {
    model: "stub",
    stream: async (opts: StreamOpts) => {
      calls.push(opts);
      const delta = reply();
      return (async function* () {
        yield { choices: [{ delta }] };
        yield { choices: [{ delta: {} }], usage: USAGE };
      })();
    },
  } as unknown as LlmClient;
}

const textReply = () => ({ content: "done." });
// Always asks for a tool, so the loop keeps iterating instead of finishing.
const toolReply = () => ({
  tool_calls: [{ index: 0, id: "c1", function: { name: "noop", arguments: "{}" } }],
});

const noopTool: ToolDefinition = {
  name: "noop",
  description: "does nothing",
  input_schema: { type: "object", properties: {} },
  modifiesFiles: true,
  execute: async () => ({ content: "ok", exitCode: 0, isError: false }),
};

const base = { systemPrompt: "sys", task: "t" };

test("forwards reasoningParams into the LLM stream call", async () => {
  const calls: StreamOpts[] = [];
  await runSubagent({
    ...base,
    llmClient: fakeClient(calls, textReply),
    tools: [],
    reasoningParams: { thinking: { type: "enabled" }, reasoning_effort: "high" },
  });
  assert.deepEqual(calls[0].thinking, { type: "enabled" });
  assert.equal(calls[0].reasoning_effort, "high");
});

test("omitting reasoningParams leaves the request untouched", async () => {
  const calls: StreamOpts[] = [];
  await runSubagent({ ...base, llmClient: fakeClient(calls, textReply), tools: [] });
  assert.equal("thinking" in calls[0], false);
  assert.equal("reasoning_effort" in calls[0], false);
});

test("reports tokensUsed and a clean finish through outMeta", async () => {
  const meta: SubagentRunMeta = {};
  const text = await runSubagent({
    ...base,
    llmClient: fakeClient([], textReply),
    tools: [],
    outMeta: meta,
  });
  assert.equal(text, "done.");
  assert.equal(meta.tokensUsed, 7);
  assert.equal(meta.degraded, null, "a natural finish must not look degraded");
  assert.equal(meta.mutatingToolExecuted, false);
});

test("flags a mutating tool call that ran", async () => {
  const meta: SubagentRunMeta = {};
  await runSubagent({
    ...base,
    llmClient: fakeClient([], toolReply),
    tools: [noopTool],
    maxIterations: 1,
    outMeta: meta,
  });
  assert.equal(meta.mutatingToolExecuted, true);
});

test("marks a budget-truncated run as degraded: budget", async () => {
  const meta: SubagentRunMeta = {};
  await runSubagent({
    ...base,
    llmClient: fakeClient([], toolReply),
    tools: [noopTool],
    budgetTokens: 1,
    outMeta: meta,
  });
  assert.equal(meta.degraded, "budget");
});

test("marks an iteration-capped run as degraded: iterations", async () => {
  const meta: SubagentRunMeta = {};
  await runSubagent({
    ...base,
    llmClient: fakeClient([], toolReply),
    tools: [noopTool],
    maxIterations: 1,
    outMeta: meta,
  });
  assert.equal(meta.degraded, "iterations");
});
