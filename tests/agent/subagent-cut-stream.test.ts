/** A model stream cut mid-response is re-sent: the run keeps its earlier steps and does not repeat tool calls. */
import test from "node:test";
import assert from "node:assert/strict";
import { runSubagent } from "../../src/agent/subagent.js";
import type { LlmClient } from "../../src/agent/llm-client.js";
import type { ToolDefinition } from "../../src/agent/types.js";

const usage = { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 };

// Request 1 asks for a tool; request 2 streams part of an answer and is cut; request 3 (the retry) answers.
function cutOnce(cut: Error, requests: unknown[][]) {
  let n = 0;
  return {
    model: "stub",
    stream: async (request: { messages: unknown[] }) => {
      requests.push(structuredClone(request.messages));
      const call = ++n;
      return (async function* () {
        if (call === 1) {
          yield { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "touch", arguments: "{}" } }] } }] };
          yield { choices: [], usage };
        } else if (call === 2) {
          yield { choices: [{ delta: { content: "partial ans" } }] };
          throw cut;
        } else {
          yield { choices: [{ delta: { content: "done." } }] };
          yield { choices: [], usage };
        }
      })();
    },
  } as unknown as LlmClient;
}

for (const cut of [new TypeError("terminated"),
                   new Error("litellm.APIConnectionError: APIConnectionError: Hosted_vllmException - Connection closed.")]) {
  test(`a cut stream (${cut.message.slice(0, 24)}) is re-sent with the same conversation`, async () => {
    const requests: unknown[][] = [];
    let touched = 0;
    const touch: ToolDefinition = {
      name: "touch", description: "side effect", input_schema: { type: "object", properties: {} }, modifiesFiles: true,
      execute: async () => { touched++; return { content: "ok", exitCode: 0, isError: false }; },
    };
    const text = await runSubagent({ systemPrompt: "sys", task: "t", llmClient: cutOnce(cut, requests), tools: [touch] });
    assert.equal(text, "done.");
    assert.equal(touched, 1, "the tool step is not repeated");
    assert.equal(requests.length, 3);
    assert.deepEqual(requests[2], requests[1], "the retry re-sends the same conversation");
    assert.ok(JSON.stringify(requests[2]).includes("c1"), "which still holds the earlier tool step");
    assert.ok(!JSON.stringify(requests[2]).includes("partial ans"), "and nothing from the cut stream");
  });
}

test("a non-transient error is still fatal and not retried", async () => {
  let n = 0;
  const llmClient = { model: "stub", stream: async () => { n++; throw new Error("invalid request: bad tool schema"); } } as unknown as LlmClient;
  await assert.rejects(runSubagent({ systemPrompt: "s", task: "t", llmClient, tools: [] }), /bad tool schema/);
  assert.equal(n, 1);
});
