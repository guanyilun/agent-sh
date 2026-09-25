/** Subagent run metadata (outMeta) + reasoning-param forwarding. */
import test from "node:test";
import assert from "node:assert/strict";
import { runSubagent, type SubagentRunMeta } from "../../src/agent/subagent.js";
import type { LlmClient } from "../../src/agent/llm-client.js";
import type { ToolDefinition } from "../../src/agent/types.js";

type StreamOpts = Record<string, unknown>;
const USAGE = { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 };

/** One assistant chunk per iteration, recording each call's opts. */
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
// Always asks for a tool, so the loop keeps iterating.
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

// A mutating tool that throws has still run: a retry-safety signal must not
// under-report, and the tokens already spent must survive the exception.
test("keeps outMeta usable when a mutating tool throws", async () => {
  const meta: SubagentRunMeta = {};
  const boom: ToolDefinition = { ...noopTool, execute: async () => { throw new Error("boom"); } };
  await assert.rejects(runSubagent({
    ...base,
    llmClient: fakeClient([], toolReply),
    tools: [boom],
    maxIterations: 1,
    outMeta: meta,
  }), /boom/);
  assert.equal(meta.mutatingToolExecuted, true, "a tool that threw mid-write still mutated");
  assert.equal(meta.tokensUsed, 7, "tokens spent before the throw should be reported");
});

test("reasoningParams cannot override the core request fields", async () => {
  const calls: StreamOpts[] = [];
  await runSubagent({
    ...base,
    llmClient: fakeClient(calls, textReply),
    tools: [],
    model: "real-model",
    reasoningParams: { model: "OVERRIDDEN", messages: [], signal: "nope", reasoning_effort: "high" },
  });
  assert.equal(calls[0].model, "real-model");
  assert.ok((calls[0].messages as unknown[]).length > 0, "messages must not be clobbered");
  assert.equal(calls[0].signal, undefined);
  assert.equal(calls[0].reasoning_effort, "high", "genuine reasoning params still pass through");
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
