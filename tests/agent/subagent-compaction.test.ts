/** A long single-turn subagent run compacts by clearing its oldest tool results. */
import test from "node:test";
import assert from "node:assert/strict";
import { runSubagent } from "../../src/agent/subagent.js";
import type { LlmClient } from "../../src/agent/llm-client.js";
import type { ToolDefinition } from "../../src/agent/types.js";

function toolCaller(rounds: number, requests: string[]) {
  let n = 0;
  return {
    model: "stub",
    stream: async (request: { messages: unknown[] }) => {
      const body = JSON.stringify(request.messages);
      requests.push(body);
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
  } as unknown as LlmClient;
}

const dump: ToolDefinition = {
  name: "dump", description: "big output", input_schema: { type: "object", properties: {} },
  execute: async () => ({ content: "x".repeat(20_000), exitCode: 0, isError: false }),
};

test("past the threshold, old tool results are cleared; the task and recent results stay", async () => {
  const requests: string[] = [];
  const text = await runSubagent({ systemPrompt: "sys", task: "the original task", llmClient: toolCaller(10, requests), tools: [dump], contextWindow: 40_000, maxIterations: 20 });
  assert.equal(text, "done.");
  const last = requests.at(-1)!;
  assert.ok(last.includes("earlier tool output cleared"), "old results were cleared");
  assert.ok(last.includes("the original task"), "the task is kept");
  assert.ok(last.includes("x".repeat(20_000)), "recent results are kept verbatim");
  assert.ok(last.length < 10 * 20_000, "the conversation shrank");
});

test("without a context window, nothing is cleared", async () => {
  const requests: string[] = [];
  await runSubagent({ systemPrompt: "sys", task: "t", llmClient: toolCaller(6, requests), tools: [dump] });
  assert.ok(!requests.at(-1)!.includes("earlier tool output cleared"));
});
