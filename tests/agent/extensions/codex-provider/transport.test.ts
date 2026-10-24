import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import OpenAI from "openai";
import { startProxy } from "../../../../src/agent/extensions/codex-provider/proxy.js";
import { AgentLoop } from "../../../../src/agent/agent-loop.js";
import { EventBus } from "../../../../src/core/event-bus.js";
import { llmErrorStatus } from "../../../../src/agent/llm-client.js";

const upstreamURL = "https://codex-transport.invalid/responses";
const request = { model: "fixture", messages: [{ role: "user" as const, content: "hi" }], stream: true as const };
const encoder = new TextEncoder();
const frame = (value: unknown) => encoder.encode(`data: ${JSON.stringify(value)}\n\n`);
const created = { type: "response.created", response: { id: "fixture" } };
const completed = { type: "response.completed", response: { status: "completed" } };
const h2Error = () => new Error("net::ERR_HTTP2_PROTOCOL_ERROR");
function body(events: unknown[], error?: Error) {
  let index = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < events.length) controller.enqueue(frame(events[index++]));
      else if (error) controller.error(error);
      else controller.close();
    },
  }), { headers: { "content-type": "text/event-stream" } });
}
const success = () => body([created, { type: "response.output_text.delta", delta: "RECOVERED" }, completed]);

async function fixture(t: TestContext, respond: (attempt: number) => Response | Promise<Response>) {
  const original = globalThis.fetch;
  let calls = 0;
  t.mock.method(globalThis, "fetch", (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (String(input) === upstreamURL) return Promise.resolve().then(() => respond(++calls));
    return original(input, init);
  });
  const proxy = await startProxy({
    secret: "fixture", upstreamURL, originator: "test",
    getCredentials: async () => ({ access: "fake", refresh: "fake", accountId: "fake", expires: Date.now() + 60_000 }),
    refreshCredentials: async () => null,
  });
  t.after(() => proxy.close());
  // Retain the SDK's normal retries: early SSE must have just one retry owner.
  const client = new OpenAI({ baseURL: proxy.baseURL, apiKey: "fixture" });
  const bus = new EventBus();
  let emitted = "";
  const loop = Object.assign(Object.create(AgentLoop.prototype), {
    bus, maxRetries: 2, getRetryDelay: () => 0,
    streamResponse: async () => {
      let text = "";
      const stream = await client.chat.completions.create(request);
      for await (const chunk of stream) {
        text += chunk.choices[0]?.delta.content ?? "";
        emitted += chunk.choices[0]?.delta.content ?? "";
      }
      return text;
    },
  });
  return { client, bus, calls: () => calls, emitted: () => emitted,
    run: (signal = new AbortController().signal) => loop.streamWithRetry("", "", signal) as Promise<string> };
}

for (const message of ["net::ERR_HTTP2_PROTOCOL_ERROR", "net::ERR_CONNECTION_RESET", "net::ERR_TIMED_OUT"]) {
  test(`recovers ${message} before upstream headers, without duplicate output`, async t => {
    const f = await fixture(t, attempt => { if (attempt === 1) throw new Error(message); return success(); });
    assert.equal(await f.run(), "RECOVERED");
    assert.equal(f.calls(), 2);
    assert.equal(f.emitted(), "RECOVERED");
  });
}

for (const error of [h2Error(), Object.assign(new TypeError("terminated"), { cause: { code: "UND_ERR_SOCKET" } })]) {
  test(`recovers a silent stream failure: ${error.message}`, async t => {
    const f = await fixture(t, attempt => attempt === 1 ? body([created], error) : success());
    assert.equal(await f.run(), "RECOVERED");
    assert.equal(f.calls(), 2);
    assert.equal(f.emitted(), "RECOVERED");
  });
}

test("recovers an incomplete stream only before output", async t => {
  const f = await fixture(t, attempt => attempt === 1 ? body([created]) : success());
  assert.equal(await f.run(), "RECOVERED");
  assert.equal(f.calls(), 2);
});

for (const event of [
  { type: "response.output_text.delta", delta: "PARTIAL" },
  { type: "response.reasoning_summary_text.delta", delta: "THINKING" },
  { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "item", call_id: "call", name: "write_file", arguments: "{}" } },
]) {
  for (const error of [h2Error(), Object.assign(new TypeError("terminated"), { cause: { code: "UND_ERR_SOCKET" } })]) {
    test(`does not replay partial ${event.type} after ${error.message}`, async t => {
      const f = await fixture(t, () => body([created, event], error));
      await assert.rejects(f.run(), (e: unknown) => {
        assert.equal(llmErrorStatus(e), 502);
        assert.equal((AgentLoop.prototype as any).isRetryable(e), false);
        return true;
      });
      assert.equal(f.calls(), 1);
      assert.equal(f.emitted(), event.type === "response.output_text.delta" ? "PARTIAL" : "");
    });
  }
}

for (const error of [
  new Error("net::ERR_CERT_AUTHORITY_INVALID"),
  Object.assign(new TypeError("fetch failed"), { cause: { code: "CERT_HAS_EXPIRED" } }),
  new TypeError("Invalid URL"),
  new DOMException("Cancelled", "AbortError"),
]) {
  test(`does not retry a permanent or cancelled fetch: ${error.message}`, async t => {
    const f = await fixture(t, () => { throw error; });
    await assert.rejects(f.run());
    assert.equal(f.calls(), 1);
  });
}

test("a model error mentioning network failure is not a transport error", async t => {
  const f = await fixture(t, () => body([created, { type: "response.failed", response: { error: { message: "fetch failed in provider validation" } } }]));
  await assert.rejects(f.run(), /provider validation/);
  assert.equal(f.calls(), 1);
});

test("persistent HTTP/2 faults exhaust exactly the agent retry budget", async t => {
  const f = await fixture(t, () => { throw h2Error(); });
  await assert.rejects(f.run(), /ERR_HTTP2_PROTOCOL_ERROR/);
  assert.equal(f.calls(), 3);
  assert.equal(f.emitted(), "");
});

test("cancel on the HTTP/2 retry announcement prevents another upload", async t => {
  const controller = new AbortController();
  const f = await fixture(t, () => { throw h2Error(); });
  f.bus.on("ui:info", () => controller.abort());
  await assert.rejects(f.run(controller.signal), /abort/i);
  assert.equal(f.calls(), 1);
});

test("non-streaming HTTP/2 faults retain the SDK recovery path", async t => {
  const f = await fixture(t, attempt => { if (attempt === 1) throw h2Error(); return success(); });
  const result = await f.client.chat.completions.create({ ...request, stream: false });
  assert.equal(result.choices[0]?.message.content, "RECOVERED");
  assert.equal(f.calls(), 2);
});

test("non-streaming certificate errors do not trigger SDK retries", async t => {
  const f = await fixture(t, () => { throw new Error("net::ERR_CERT_AUTHORITY_INVALID"); });
  await assert.rejects(f.client.chat.completions.create({ ...request, stream: false }));
  assert.equal(f.calls(), 1);
});

for (const status of [400, 403, 429, 503]) {
  test(`an unreadable HTTP ${status} error body preserves its retry decision`, async t => {
    const f = await fixture(t, () => new Response(new ReadableStream({
      start(controller) { controller.error(h2Error()); },
    }), { status, headers: { "retry-after": "0" } }));
    await assert.rejects(f.run(), (error: unknown) => {
      assert.equal(llmErrorStatus(error), status);
      return true;
    });
    assert.equal(f.calls(), status === 429 || status >= 500 ? 3 : 1);
  });
}

test("a missing success body is not a successful empty reply", async t => {
  const f = await fixture(t, attempt => attempt === 1 ? new Response(null, { status: 204 }) : success());
  assert.equal(await f.run(), "RECOVERED");
  assert.equal(f.calls(), 2);
});

test("non-streaming retries discard buffered partial text", async t => {
  const f = await fixture(t, attempt => attempt === 1
    ? body([created, { type: "response.output_text.delta", delta: "DISCARDED" }], h2Error()) : success());
  const result = await f.client.chat.completions.create({ ...request, stream: false });
  assert.equal(result.choices[0]?.message.content, "RECOVERED");
  assert.equal(f.calls(), 2);
});

for (const type of ["response.completed", "response.done", "response.incomplete"]) {
  for (const stream of [true, false] as const) {
    test(`${type} survives cleanup failure after ${stream ? "streaming" : "buffered"} output`, async t => {
      let cancellations = 0;
      const f = await fixture(t, () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(frame({ type: "response.output_text.delta", delta: "FINISHED" }));
          controller.enqueue(frame({ type, response: {
            status: type === "response.incomplete" ? "incomplete" : "completed",
            usage: { input_tokens: 3, output_tokens: 2 },
          } }));
        },
        async cancel() {
          cancellations++;
          throw h2Error();
        },
      })));
      const finishReason = type === "response.incomplete" ? "length" : "stop";
      if (stream) {
        const response = await f.client.chat.completions.create({ ...request, stream: true });
        const chunks = [];
        for await (const chunk of response) chunks.push(chunk);
        assert.equal(chunks.map(c => c.choices[0]?.delta.content ?? "").join(""), "FINISHED");
        assert(chunks.some(c => c.choices[0]?.finish_reason === finishReason));
        assert(chunks.some(c => c.usage?.total_tokens === 5));
      } else {
        const response = await f.client.chat.completions.create({ ...request, stream: false });
        assert.equal(response.choices[0]?.message.content, "FINISHED");
        assert.equal(response.choices[0]?.finish_reason, finishReason);
        assert.equal(response.usage?.total_tokens, 5);
      }
      assert.equal(f.calls(), 1, "a completed response must not be retried");
      assert.equal(cancellations, 1, "still release the unread upstream body");
    });
  }
}
