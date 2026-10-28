import test from "node:test";
import assert from "node:assert/strict";
import { EventBus } from "../../src/core/event-bus.js";
import { runSubagent, type SubagentRunMeta, type SubagentUsage } from "../../src/agent/subagent.js";
import type { LlmClient } from "../../src/agent/llm-client.js";
import type { ToolDefinition } from "../../src/agent/types.js";

function client(replies: Record<string, unknown>[], requests: Record<string, unknown>[] = []) {
  return {
    model: "parent",
    stream: async (request: Record<string, unknown>) => {
      requests.push(request);
      const delta = replies.shift() ?? {};
      return (async function* () {
        yield { choices: [{ delta }] };
        yield { choices: [], usage: { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11, prompt_tokens_details: { cached_tokens: 4 } } };
      })();
    },
  } as unknown as LlmClient;
}
const base = { systemPrompt: "focused", task: "task" };
const call = (name: string, index = 0) => ({ index, id: `c${index}`, function: { name, arguments: "{}" } });
const tool = (name: string, execute: ToolDefinition["execute"], modifiesFiles = false): ToolDefinition => ({
  name, description: name, input_schema: { type: "object", properties: {} }, modifiesFiles, execute,
});
const ok = { content: "ok", exitCode: 0, isError: false };

test("compatibility runs use model order, not parallel/read-only-first tool scheduling", async () => {
  const seen: string[] = [];
  const tools = [
    tool("write", async () => { seen.push("write"); return ok; }, true),
    tool("read", async () => { seen.push("read-start"); await new Promise(resolve => setTimeout(resolve, 10)); seen.push("read-end"); return ok; }),
    tool("last", async () => { seen.push("last"); return ok; }),
  ];
  await runSubagent({ ...base, tools, llmClient: client([
    { tool_calls: [call("write"), call("read", 1), call("last", 2)] }, { content: "done" },
  ]) });
  assert.deepEqual(seen, ["write", "read-start", "read-end", "last"]);
});

test("returns the last nonempty assistant text rather than concatenated engine text", async () => {
  const text = await runSubagent({ ...base, tools: [tool("noop", async () => ok)], llmClient: client([
    { content: "first", tool_calls: [call("noop")] },
    { content: "last nonempty", tool_calls: [call("noop")] },
    {},
  ]) });
  assert.equal(text, "last nonempty");
});

test("forks capable clients for overrides without mutating or reconfiguring the parent", async () => {
  const requests: Record<string, unknown>[] = [];
  const forked = client([{ content: "done" }], requests);
  const parent = client([]);
  parent.fork = overrides => { assert.deepEqual(overrides, { model: "child" }); return forked; };
  parent.reconfigure = () => { assert.fail("must not reconfigure parent"); };
  await runSubagent({ ...base, tools: [], llmClient: parent, model: "child" });
  assert.equal(parent.model, "parent");
  assert.equal(requests[0].model, "child");
});

test("history stays append-only, reasoning is replayable, usage includes cached tokens", async () => {
  const first: SubagentRunMeta = {};
  const usage: SubagentUsage[] = [];
  await runSubagent({ ...base, tools: [], llmClient: client([
    { content: "one", reasoning_content: "reason" },
  ]), outMeta: first, onUsage: u => usage.push(u) });
  const history = structuredClone(first.messages!);
  const second: SubagentRunMeta = {};
  await runSubagent({ ...base, task: "continue", history, tools: [], llmClient: client([{ content: "two" }]), outMeta: second });
  assert.deepEqual(history, first.messages);
  assert.deepEqual(second.messages!.slice(0, history.length), history);
  assert.equal((history[1] as unknown as Record<string, unknown>).reasoning_content, "reason");
  assert.equal(usage[0].cached_tokens, 4);
  assert.equal(first.tokensUsed, 2);
});

test("only tool rendering events are forwarded; parent steering cannot reach child", async () => {
  const bus = new EventBus();
  const events: string[] = [];
  bus.onAny(name => events.push(name));
  const tools = [tool("noop", async (_args, onChunk) => {
    bus.emit("agent:steer", { text: "parent-only" });
    onChunk?.("chunk");
    return ok;
  })];
  const requests: Record<string, unknown>[] = [];
  await runSubagent({ ...base, bus, tools, llmClient: client([
    { tool_calls: [call("noop")] }, { content: "done" },
  ], requests) });
  assert.deepEqual(events, ["agent:tool-started", "agent:steer", "agent:tool-output-chunk", "agent:tool-completed"]);
  assert.doesNotMatch(JSON.stringify(requests), /parent-only/);
});

test("provider failures preserve their raw message", async () => {
  const llmClient = client([]);
  llmClient.stream = async () => { throw new Error("provider down"); };
  await assert.rejects(runSubagent({ ...base, tools: [], llmClient }), {
    message: "provider down",
  });
});

test("a thrown tool stops the batch and retains mutation, usage and history metadata", async () => {
  const meta: SubagentRunMeta = {};
  let laterRan = false;
  await assert.rejects(runSubagent({ ...base, outMeta: meta,
    tools: [
      tool("write", async () => { throw new Error("write failed"); }, true),
      tool("later", async () => { laterRan = true; return ok; }),
    ],
    llmClient: client([{ tool_calls: [call("write"), call("later", 1)] }]),
  }), { message: "write failed" });
  assert.equal(laterRan, false);
  assert.equal(meta.mutatingToolExecuted, true);
  assert.equal(meta.tokensUsed, 2);
  assert.ok(meta.messages?.some(message => message.role === "tool"));
});

test("cancellation settles even when the provider ignores its internal signal", { timeout: 2000 }, async () => {
  const controller = new AbortController();
  const llmClient = client([]);
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  let signal: AbortSignal | undefined;
  llmClient.stream = async request => {
    signal = request.signal;
    entered();
    return new Promise(() => {});
  };
  const running = runSubagent({ ...base, tools: [], llmClient, signal: controller.signal });
  await started;
  controller.abort();
  assert.equal(await running, "");
  assert.ok(signal instanceof AbortSignal);
  assert.equal(signal.aborted, true);
});

test("failed run details throw after copying usage and history metadata", async () => {
  const meta: SubagentRunMeta = {};
  await assert.rejects(runSubagent({ ...base, tools: [], outMeta: meta,
    llmClient: client([{ content: "done" }]),
    onMessage: message => { if (message.role === "assistant") throw new Error("transcript failed"); },
  }), /transcript failed/);
  assert.equal(meta.tokensUsed, 2);
  assert.ok(meta.messages?.length);
});
