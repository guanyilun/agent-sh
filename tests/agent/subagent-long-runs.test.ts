/** What keeps a long unattended run healthy: a run compacted at a chosen size, messages from outside delivered
 *  between tool rounds, and a silent endpoint given up on in time. */
import test from "node:test";
import assert from "node:assert/strict";
import { runSubagent } from "../../src/agent/subagent.js";
import type { AgentShMessage, LlmClient } from "../../src/agent/llm-client.js";
import type { ToolDefinition } from "../../src/agent/types.js";

const usage = (prompt: number) => ({ prompt_tokens: prompt, completion_tokens: 2, total_tokens: prompt + 2 });
const big = (tag: string) => `${tag} START ` + "x".repeat(12000) + ` ${tag} END`;
const reader: ToolDefinition = {
  name: "read_file", description: "read", input_schema: { type: "object", properties: { path: { type: "string" } } },
  execute: async (args) => ({ content: big(String((args as { path: string }).path)), exitCode: 0, isError: false }),
};
const callTool = (id: string, path: string) => ({ choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name: "read_file", arguments: JSON.stringify({ path }) } }] } }] });

test("a subagent's run is compacted once its prompt passes contextTokens, and not before", async () => {
  const requests: AgentShMessage[][] = [];
  let n = 0;
  const llmClient = {
    model: "stub",
    stream: async (request: { messages: AgentShMessage[] }) => {
      requests.push(structuredClone(request.messages));
      const call = ++n;
      const sent = Math.ceil(JSON.stringify(request.messages).length / 4);
      return (async function* () {
        if (call <= 45) yield callTool(`c${call}`, `file${call}`); else yield { choices: [{ delta: { content: "done." } }] };
        yield { choices: [], usage: usage(sent) };
      })();
    },
  } as unknown as LlmClient;
  const text = await runSubagent({ systemPrompt: "sys", task: "t", llmClient, tools: [reader], contextTokens: 40000, maxIterations: 60 });
  assert.equal(text, "done.");
  const sizes = requests.map(r => JSON.stringify(r).length);
  assert.ok(sizes[3]! > sizes[2]! && sizes[2]! > sizes[1]!, "it grows untouched below the limit");
  assert.ok(Math.max(...sizes) < 40000 * 4 * 1.3, `the prompt stays near the limit (largest ${Math.max(...sizes)} chars)`);
  const last = JSON.stringify(requests[requests.length - 1]);
  assert.ok(last.includes("earlier tool output cleared") || last.includes("earlier steps of this run were removed"), "old output is gone");
  assert.ok(last.includes("file45 START") && last.includes("x".repeat(12000)), "the latest result is whole");
  const drops = sizes.filter((s, i) => i > 0 && s < sizes[i - 1]!).length;
  assert.ok(drops >= 1 && drops <= 12, `compaction happens in batches, not on every call (${drops} of ${sizes.length})`);
});

test("without contextTokens or a known window nothing is compacted", async () => {
  const requests: string[] = [];
  let n = 0;
  const llmClient = { model: "stub", stream: async (request: { messages: unknown[] }) => {
    requests.push(JSON.stringify(request.messages));
    const call = ++n;
    return (async function* () {
      if (call <= 9) yield callTool(`c${call}`, `file${call}`); else yield { choices: [{ delta: { content: "done." } }] };
      yield { choices: [], usage: usage(100) };
    })();
  } } as unknown as LlmClient;
  await runSubagent({ systemPrompt: "sys", task: "t", llmClient, tools: [reader], maxIterations: 30 });
  assert.ok(!requests[requests.length - 1]!.includes("earlier tool output cleared") && !requests[requests.length - 1]!.includes("were removed"));
});

test("an endpoint that sends nothing is given up on after firstByteTimeoutMs, retried, and then fails", async () => {
  let n = 0;
  const llmClient = { model: "stub", stream: async (request: { signal?: AbortSignal }) => {
    n++;
    return (async function* () {
      await new Promise((_, reject) => request.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
      yield { choices: [{ delta: { content: "never" } }] };
    })();
  } } as unknown as LlmClient;
  const started = Date.now();
  await assert.rejects(runSubagent({ systemPrompt: "s", task: "t", llmClient, tools: [], firstByteTimeoutMs: 60, retryWindowMs: 60_000 }),
                       /ETIMEDOUT.*sent nothing/);
  assert.ok(n >= 2 && n <= 4, `retried a fixed few times (${n} calls), not for the whole retry window`);
  assert.ok(Date.now() - started < 30_000);
});

test("a slow first byte within the limit is fine, and later silence is not policed", async () => {
  const llmClient = { model: "stub", stream: async () => (async function* () {
    await new Promise(r => setTimeout(r, 40));
    yield { choices: [{ delta: { content: "a" } }] };
    await new Promise(r => setTimeout(r, 200));
    yield { choices: [{ delta: { content: "b" } }] };
    yield { choices: [], usage: usage(5) };
  })() } as unknown as LlmClient;
  assert.equal(await runSubagent({ systemPrompt: "s", task: "t", llmClient, tools: [], firstByteTimeoutMs: 120 }), "ab");
});
