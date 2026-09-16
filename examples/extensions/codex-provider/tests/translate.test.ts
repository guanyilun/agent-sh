import { test } from "node:test";
import assert from "node:assert/strict";
import {
  aggregate,
  CodexStreamTranslator,
  parseSSE,
  REASONING_DETAIL_TYPE,
  toResponsesRequest,
  upstreamErrorMessage,
  type ChatChunk,
} from "../translate.js";

const IMG = "data:image/png;base64,AAAA";

test("toResponsesRequest: leading system → instructions, later system → developer message", () => {
  const body = toResponsesRequest({
    model: "gpt-5.5",
    messages: [
      { role: "system", content: "You are ash." },
      { role: "system", content: "Extra rules." },
      { role: "user", content: "hi" },
      { role: "system", content: "[note] cwd changed" },
    ],
  });
  assert.equal(body.instructions, "You are ash.\n\nExtra rules.");
  assert.deepEqual(body.input, [
    { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
    { type: "message", role: "developer", content: [{ type: "input_text", text: "[note] cwd changed" }] },
  ]);
  assert.equal(body.store, false);
  assert.equal(body.stream, true);
  assert.deepEqual(body.include, ["reasoning.encrypted_content"]);
  assert.deepEqual(body.reasoning, { summary: "auto" });
  assert.equal(body.tools, undefined);
  assert.equal(body.tool_choice, undefined);
});

test("toResponsesRequest: images, tool calls, tool outputs, replayed reasoning", () => {
  const reasoningItem = { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "enc" };
  const body = toResponsesRequest({
    model: "gpt-5.5",
    messages: [
      { role: "system", content: "sys" },
      { role: "user", content: [{ type: "text", text: "look" }, { type: "image_url", image_url: { url: IMG } }] },
      {
        role: "assistant",
        content: "Checking.",
        tool_calls: [{ id: "call_1", type: "function", function: { name: "bash", arguments: '{"cmd":"ls"}' } }],
        reasoning: "summary text (ignored)",
        reasoning_details: [
          { index: 0, type: REASONING_DETAIL_TYPE, item: reasoningItem },
          { index: 1, type: "other.provider", text: "ignored" },
        ],
      } as never,
      { role: "tool", tool_call_id: "call_1", content: "a.txt" },
      { role: "tool", tool_call_id: "call_2", content: [{ type: "text", text: "[1 image(s)]" }, { type: "image_url", image_url: { url: IMG } }] },
      { role: "assistant", content: null, tool_calls: [{ id: "call_3", function: { name: "noop", arguments: "" } }] },
    ],
  });
  assert.deepEqual(body.input, [
    { type: "message", role: "user", content: [
      { type: "input_text", text: "look" },
      { type: "input_image", image_url: IMG, detail: "auto" },
    ] },
    reasoningItem,
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "Checking.", annotations: [] }] },
    { type: "function_call", call_id: "call_1", name: "bash", arguments: '{"cmd":"ls"}' },
    { type: "function_call_output", call_id: "call_1", output: "a.txt" },
    { type: "function_call_output", call_id: "call_2", output: [
      { type: "input_text", text: "[1 image(s)]" },
      { type: "input_image", image_url: IMG, detail: "auto" },
    ] },
    { type: "function_call", call_id: "call_3", name: "noop", arguments: "{}" },
  ]);
});

test("toResponsesRequest: tools, reasoning effort, session cache key", () => {
  const body = toResponsesRequest({
    model: "gpt-5.5",
    messages: [{ role: "user", content: "x" }],
    tools: [
      { type: "function", function: { name: "bash", description: "Run", parameters: { type: "object", properties: { cmd: { type: "string" } } } } },
      { type: "function", function: { name: "bare" } },
    ],
    reasoning_effort: "high",
  }, { sessionId: "sess-1" });
  assert.deepEqual(body.tools, [
    { type: "function", name: "bash", description: "Run", parameters: { type: "object", properties: { cmd: { type: "string" } } }, strict: false },
    { type: "function", name: "bare", description: "", parameters: { type: "object", properties: {} }, strict: false },
  ]);
  assert.equal(body.tool_choice, "auto");
  assert.equal(body.parallel_tool_calls, true);
  assert.deepEqual(body.reasoning, { effort: "high", summary: "auto" });
  assert.equal(body.prompt_cache_key, "sess-1");
});

function run(events: Record<string, unknown>[]): ChatChunk[] {
  const t = new CodexStreamTranslator("gpt-5.5");
  return [...events.flatMap((e) => t.push(e)), ...t.end()];
}

const deltas = (chunks: ChatChunk[]) => chunks.map((c) => c.choices[0]?.delta ?? {});

test("translator: text, reasoning, tool calls, reasoning replay, usage, finish", () => {
  const reasoning = { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "Plan" }], encrypted_content: "enc" };
  const chunks = run([
    { type: "response.created", response: { id: "resp_1" } },
    { type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs_1" } },
    { type: "response.reasoning_summary_part.added", summary_index: 0 },
    { type: "response.reasoning_summary_text.delta", delta: "Plan" },
    { type: "response.reasoning_summary_part.added", summary_index: 1 },
    { type: "response.reasoning_summary_text.delta", delta: "More" },
    { type: "response.output_item.done", output_index: 0, item: reasoning },
    { type: "response.output_item.added", output_index: 1, item: { type: "message", id: "msg_1" } },
    { type: "response.output_text.delta", delta: "Hel" },
    { type: "response.output_text.delta", delta: "lo" },
    { type: "response.output_item.added", output_index: 2, item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "bash", arguments: "" } },
    { type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 2, delta: '{"cmd":' },
    { type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 2, delta: '"ls"}' },
    { type: "response.output_item.done", output_index: 2, item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "bash", arguments: '{"cmd":"ls"}' } },
    { type: "response.completed", response: { status: "completed", usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, input_tokens_details: { cached_tokens: 4 } } } },
  ]);
  const d = deltas(chunks);
  assert.equal(d[0]!.role, "assistant", "first delta carries the role");
  assert.equal(d.map((x) => x.reasoning ?? "").join(""), "Plan\n\nMore");
  assert.equal(d.map((x) => x.content ?? "").join(""), "Hello");
  assert.deepEqual(d.flatMap((x) => (x.reasoning_details as unknown[]) ?? []), [
    { index: 0, type: REASONING_DETAIL_TYPE, item: reasoning },
  ]);
  const calls = d.flatMap((x) => (x.tool_calls as any[]) ?? []);
  assert.deepEqual(calls[0], { index: 0, id: "call_1", type: "function", function: { name: "bash", arguments: "" } });
  assert.equal(calls.map((c) => c.function.arguments).join(""), '{"cmd":"ls"}');
  const finish = chunks.find((c) => c.choices[0]?.finish_reason);
  assert.equal(finish!.choices[0]!.finish_reason, "tool_calls");
  const usage = chunks.at(-1)!;
  assert.deepEqual(usage.choices, []);
  assert.deepEqual(usage.usage, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, prompt_tokens_details: { cached_tokens: 4 } });
});

test("translator: arguments.done supplies a tail the deltas missed; incomplete → length", () => {
  const chunks = run([
    { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc_9", call_id: "call_9", name: "read" } },
    { type: "response.function_call_arguments.delta", item_id: "fc_9", delta: '{"pa' },
    { type: "response.function_call_arguments.done", item_id: "fc_9", arguments: '{"path":"a"}' },
    { type: "response.output_item.done", item: { type: "function_call", id: "fc_9", call_id: "call_9", name: "read", arguments: '{"path":"a"}' } },
    { type: "response.incomplete", response: { status: "incomplete" } },
  ]);
  const args = deltas(chunks).flatMap((x) => (x.tool_calls as any[]) ?? []).map((c) => c.function.arguments).join("");
  assert.equal(args, '{"path":"a"}');
  assert.equal(chunks.find((c) => c.choices[0]?.finish_reason)!.choices[0]!.finish_reason, "length");
});

test("translator: plain text ends with stop; upstream failures throw", () => {
  const chunks = run([{ type: "response.output_text.delta", delta: "ok" }, { type: "response.completed", response: { status: "completed" } }]);
  assert.equal(chunks.find((c) => c.choices[0]?.finish_reason)!.choices[0]!.finish_reason, "stop");
  assert.equal(chunks.some((c) => c.usage), false);

  const t = new CodexStreamTranslator("m");
  assert.throws(() => t.push({ type: "response.failed", response: { error: { message: "boom" } } }), /boom/);
  assert.throws(() => t.push({ type: "error", message: "bad request" }), /bad request/);
});

test("aggregate: folds chunks into a chat.completion", () => {
  const chunks = run([
    { type: "response.output_text.delta", delta: "Hi" },
    { type: "response.output_item.added", output_index: 1, item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "bash", arguments: "" } },
    { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: "{}" },
    { type: "response.completed", response: { status: "completed", usage: { input_tokens: 3, output_tokens: 2 } } },
  ]);
  const body = aggregate(chunks) as any;
  assert.equal(body.object, "chat.completion");
  assert.equal(body.choices[0].message.content, "Hi");
  assert.deepEqual(body.choices[0].message.tool_calls, [{ id: "call_1", type: "function", function: { name: "bash", arguments: "{}" } }]);
  assert.equal(body.choices[0].finish_reason, "tool_calls");
  assert.equal(body.usage.total_tokens, 5);
});

test("parseSSE: reassembles events split across chunks, CRLF, [DONE]", async () => {
  const enc = new TextEncoder();
  const raw = 'event: x\r\ndata: {"type":"a"}\r\n\r\ndata: {"ty' + 'pe":"b"}\n\n: comment\n\ndata: [DONE]\n\ndata: {"type":"c"}';
  async function* body() {
    for (let i = 0; i < raw.length; i += 7) yield enc.encode(raw.slice(i, i + 7));
  }
  const types: string[] = [];
  for await (const e of parseSSE(body())) types.push(e.type);
  assert.deepEqual(types, ["a", "b", "c"]);
});

test("upstreamErrorMessage: usage limits get a friendly message", () => {
  const resetsAt = Math.floor(Date.now() / 1000) + 30 * 60;
  const msg = upstreamErrorMessage(429, JSON.stringify({ error: { type: "usage_limit_reached", plan_type: "PLUS", resets_at: resetsAt } }));
  assert.match(msg, /usage limit reached \(plus plan\)\. Resets in ~(29|30) min\./);
  assert.equal(upstreamErrorMessage(400, JSON.stringify({ detail: "Unsupported model" })), "Codex backend error 400: Unsupported model");
  assert.equal(upstreamErrorMessage(502, "Bad gateway"), "Codex backend error 502: Bad gateway");
});
