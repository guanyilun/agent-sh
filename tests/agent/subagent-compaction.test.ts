/** A long single-turn subagent run compacts: old tool results first, then a cut. */
import test from "node:test";
import assert from "node:assert/strict";
import { runSubagent } from "../../src/agent/subagent.js";
import { CLEARED, REMOVED, findCut } from "../../src/agent/subagent-compaction.js";
import type { LlmClient } from "../../src/agent/llm-client.js";
import type { ToolDefinition } from "../../src/agent/types.js";

type Wire = { role: string; content?: unknown; tool_calls?: { id: string }[]; tool_call_id?: string };

function toolCaller(rounds: number, summary?: string) {
  const requests: Wire[][] = [];
  const summaries: unknown[] = [];
  let n = 0;
  const client = {
    model: "stub",
    stream: async (request: { messages: Wire[] }) => {
      const body = JSON.stringify(request.messages);
      requests.push(JSON.parse(body));
      const call = ++n;
      // Report a realistic prompt size: the engine anchors its estimate to it.
      const prompt_tokens = Math.ceil(body.length / 4);
      const usage = { prompt_tokens, completion_tokens: 2, total_tokens: prompt_tokens + 2 };
      return (async function* () {
        if (call <= rounds) yield { choices: [{ delta: { tool_calls: [{ index: 0, id: `c${call}`, function: { name: "dump", arguments: "{}" } }] } }] };
        else yield { choices: [{ delta: { content: "done." } }] };
        yield { choices: [], usage };
      })();
    },
    ...(summary !== undefined ? { complete: async (opts: unknown) => { summaries.push(opts); return summary; } } : {}),
  } as unknown as LlmClient;
  return { client, requests, summaries };
}

const dump = (chars: number): ToolDefinition => ({
  name: "dump", description: "big output", input_schema: { type: "object", properties: {} },
  execute: async () => ({ content: "x".repeat(chars), exitCode: 0, isError: false }),
});

function assertPaired(messages: Wire[]) {
  const called = new Set<string>();
  for (const m of messages) {
    for (const c of m.tool_calls ?? []) called.add(c.id);
    if (m.role === "tool") assert.ok(called.has(m.tool_call_id!), `tool result ${m.tool_call_id} keeps its call`);
  }
}

test("clearing old tool results is enough: task and recent results stay, no summary", async () => {
  const { client, requests, summaries } = toolCaller(30, "unused");
  const text = await runSubagent({ systemPrompt: "sys", task: "the original task", llmClient: client, tools: [dump(10_000)], contextWindow: 80_000, maxIterations: 40 });
  assert.equal(text, "done.");
  const last = JSON.stringify(requests.at(-1));
  assert.ok(last.includes(CLEARED.slice(1)), "old results were cleared");
  assert.ok(!last.includes(REMOVED.slice(1)), "no cut needed");
  assert.ok(last.includes("the original task"));
  assert.ok(last.includes("x".repeat(10_000)), "recent results are verbatim");
  assertPaired(requests.at(-1)!);
});

test("still over target: the middle of the run is cut, keeping the task, without a model call", async () => {
  const { client, requests, summaries } = toolCaller(10, "unused");
  const text = await runSubagent({ systemPrompt: "sys", task: "the original task", llmClient: client, tools: [dump(20_000)], contextWindow: 40_000, maxIterations: 20 });
  assert.equal(text, "done.");
  assert.equal(summaries.length, 0, "no model call");
  const last = requests.at(-1)!;
  const body = JSON.stringify(last);
  assert.ok(body.includes(REMOVED.slice(1)), "a marker says steps were removed");
  assert.equal(body.split(REMOVED.slice(1)).length - 1, 1, "repeated cuts leave one marker");
  assert.ok(body.includes("the original task"), "the task is kept");
  // Threshold is (40k - 8192 reserve) * 0.8 ≈ 25k tokens ≈ 100k chars; uncompacted, the last request is ~200k.
  const largest = Math.max(...requests.map(r => JSON.stringify(r).length));
  assert.ok(largest < 125_000, `every request stays near the threshold (largest ${largest})`);
  assertPaired(last);
});

test("without a context window, nothing is compacted", async () => {
  const { client, requests } = toolCaller(6);
  await runSubagent({ systemPrompt: "sys", task: "t", llmClient: client, tools: [dump(20_000)] });
  assert.ok(!JSON.stringify(requests.at(-1)).includes(CLEARED.slice(1)));
});

test("findCut never starts the kept tail at a tool result", () => {
  const msgs = [
    { role: "user", content: "task" },
    { role: "assistant", content: "", tool_calls: [{ id: "a", type: "function", function: { name: "t", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "a", content: "y".repeat(100) },
    { role: "assistant", content: "", tool_calls: [{ id: "b", type: "function", function: { name: "t", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "b", content: "z".repeat(100) },
  ] as never[];
  for (let budget = 0; budget < 200; budget += 5) {
    const cut = findCut(msgs, 1, budget);
    assert.ok(cut === msgs.length || (msgs[cut] as Wire).role !== "tool", `budget ${budget} → cut ${cut}`);
  }
});
