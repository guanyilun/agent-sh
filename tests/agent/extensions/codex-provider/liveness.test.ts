import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import OpenAI from "openai";
import { startProxy, type ProxyOptions } from "../../../../src/agent/extensions/codex-provider/proxy.js";
import { llmErrorStatus } from "../../../../src/agent/llm-client.js";
import { AgentLoop } from "../../../../src/agent/agent-loop.js";

const request = { model: "test-model", messages: [{ role: "user" as const, content: "hello" }], stream: true as const };
const credentials = { access: "fake-access", refresh: "fake-refresh", accountId: "fake-account", expires: Date.now() + 3600000 };
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function event(res: http.ServerResponse, data: unknown) { res.write(`data: ${JSON.stringify(data)}\n\n`); }
function start(res: http.ServerResponse) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  event(res, { type: "response.created", response: { id: "test" } });
}
function finish(res: http.ServerResponse) {
  event(res, { type: "response.output_text.delta", delta: "done" });
  event(res, { type: "response.completed", response: { status: "completed" } });
  res.end();
}
async function fixture(t: TestContext, respond: (res: http.ServerResponse) => void, options: Partial<ProxyOptions> = {}) {
  let requests = 0;
  let markClosed!: () => void;
  const closed = new Promise<void>(resolve => { markClosed = resolve; });
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      requests++;
      res.on("close", markClosed);
      respond(res);
    });
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const proxy = await startProxy({
    secret: "test-only", upstreamURL: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/responses`,
    originator: "test", getCredentials: async () => credentials, refreshCredentials: async () => null,
    heartbeatIntervalMs: 20, idleTimeoutMs: 1500, headersTimeoutMs: 1500, credentialsTimeoutMs: 1500, ...options,
  });
  t.after(async () => {
    await proxy.close();
    upstream.closeAllConnections();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  });
  return { proxy, closed, requests: () => requests,
    client: new OpenAI({ apiKey: "test-only", baseURL: proxy.baseURL, maxRetries: 0 }),
    raw: (stream = true) => fetch(proxy.baseURL + "/chat/completions", {
      method: "POST", headers: { authorization: "Bearer test-only", "content-type": "application/json" },
      body: JSON.stringify({ ...request, stream }), signal: AbortSignal.timeout(4000),
    }),
  };
}

test("flushes headers before translated output; SDK neither times out nor retries", { timeout: 5000 }, async t => {
  let release!: () => void;
  const f = await fixture(t, res => { start(res); release = () => finish(res); });
  const client = new OpenAI({ apiKey: "test-only", baseURL: f.proxy.baseURL, timeout: 200 });
  // No translated events exist yet. Before the fix this promise times out and retries.
  const stream = await client.chat.completions.create(request);
  await delay(300); // Longer than the client's header deadline.
  release();
  let content = "";
  for await (const chunk of stream) content += chunk.choices[0]?.delta.content ?? "";
  assert.equal(content, "done");
  assert.equal(f.requests(), 1);
});

test("keeps the SDK connected while uploading or waiting for upstream headers", { timeout: 5000 }, async t => {
  const f = await fixture(t, res => {
    const timer = setTimeout(() => { start(res); finish(res); }, 450);
    res.on("close", () => clearTimeout(timer));
  });
  const client = new OpenAI({ apiKey: "test-only", baseURL: f.proxy.baseURL, timeout: 150, maxRetries: 0 });
  const stream = await client.chat.completions.create(request);
  let content = "";
  for await (const chunk of stream) content += chunk.choices[0]?.delta.content ?? "";
  assert.equal(content, "done");
  assert.equal(f.requests(), 1, "slow uploads must not start duplicate model requests");
});

test("emits invisible keepalives while reasoning is silent", { timeout: 5000 }, async t => {
  let release!: () => void;
  const f = await fixture(t, res => { start(res); release = () => finish(res); });
  const response = await f.raw();
  const reader = response.body!.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.match(first, /^: keepalive\n\n/);
  assert(!first.includes("data:"), "keepalives must not fabricate model content or usage");
  release();
  let rest = "";
  for (;;) { const part = await reader.read(); if (part.done) break; rest += new TextDecoder().decode(part.value); }
  assert.match(rest, /done/);
  assert.match(rest, /\[DONE\]/);
});

test("raw upstream comments reset inactivity even when the translator emits nothing", { timeout: 5000 }, async t => {
  const f = await fixture(t, res => {
    start(res);
    const interval = setInterval(() => res.write(": upstream progress\n\n"), 40);
    const timer = setTimeout(() => finish(res), 450);
    res.on("close", () => { clearInterval(interval); clearTimeout(timer); });
  }, { idleTimeoutMs: 150 });
  const stream = await f.client.chat.completions.create(request);
  let content = "";
  for await (const chunk of stream) content += chunk.choices[0]?.delta.content ?? "";
  assert.equal(content, "done");
  assert.equal(f.requests(), 1);
});

test("downstream heartbeats do not keep an unresponsive upstream alive", { timeout: 5000 }, async t => {
  const f = await fixture(t, start, { idleTimeoutMs: 120 });
  const response = await f.raw();
  const text = await response.text();
  assert.match(text, /: keepalive/);
  assert.match(text, /Codex upstream timed out waiting for stream data after 0.12s/);
  assert(!text.includes("[DONE]"));
  await f.closed;
});

test("SDK surfaces stream inactivity as an error, not a successful empty answer", { timeout: 5000 }, async t => {
  const f = await fixture(t, start, { idleTimeoutMs: 120 });
  const stream = await f.client.chat.completions.create(request);
  await assert.rejects(async () => { for await (const _ of stream) { /* drain */ } }, /waiting for stream data/);
  await f.closed;
});

test("a stalled handshake is bounded and identifies the timeout phase", { timeout: 5000 }, async t => {
  const f = await fixture(t, () => {}, { headersTimeoutMs: 120 });
  const response = await f.raw();
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.match(text, /waiting for response headers after 0.12s/);
  assert.match(text, /"status":504/);
  assert(!text.includes("[DONE]"));
  await f.closed;
});

test("a header deadline does not silently re-upload through SDK retries", { timeout: 5000 }, async t => {
  const f = await fixture(t, () => {}, { headersTimeoutMs: 100 });
  const client = new OpenAI({ apiKey: "test-only", baseURL: f.proxy.baseURL });
  const stream = await client.chat.completions.create(request);
  await assert.rejects(async () => { for await (const _ of stream) {} }, (e: unknown) => {
    assert.equal(llmErrorStatus(e), 504);
    assert.equal((AgentLoop.prototype as any).isRetryable(e), false);
    return true;
  });
  assert.equal(f.requests(), 1);
  await f.closed;
});

test("non-streaming header deadlines also disable hidden SDK retries", { timeout: 5000 }, async t => {
  const f = await fixture(t, () => {}, { headersTimeoutMs: 100 });
  const client = new OpenAI({ apiKey: "test-only", baseURL: f.proxy.baseURL });
  await assert.rejects(client.chat.completions.create({ ...request, stream: false }), (e: unknown) => llmErrorStatus(e) === 504);
  assert.equal(f.requests(), 1);
  await f.closed;
});

test("cancel during header wait releases upstream without resuming work", { timeout: 5000 }, async t => {
  const f = await fixture(t, () => {});
  const controller = new AbortController();
  const stream = await f.client.chat.completions.create(request, { signal: controller.signal });
  // Wait until the upload reaches upstream, then cancel before its headers.
  while (!f.requests()) await delay(5);
  controller.abort();
  try { for await (const _ of stream) {} } catch { /* expected cancellation */ }
  await f.closed;
  assert.equal(f.requests(), 1);
});

for (const status of [400, 401, 403, 408, 409, 429, 500, 501, 503, 504, 529]) {
  test(`early SSE preserves upstream ${status} and retry policy`, { timeout: 5000 }, async t => {
    const f = await fixture(t, res => {
      res.writeHead(status, { "content-type": "application/json", "retry-after": "7" });
      res.end(JSON.stringify({ error: { message: "upstream fixture" } }));
    });
    const stream = await f.client.chat.completions.create(request);
    await assert.rejects(async () => { for await (const _ of stream) {} }, (e: unknown) => {
      assert.equal(llmErrorStatus(e), status);
      const loop = AgentLoop.prototype as any;
      assert.equal(loop.isRetryable(e), [408, 409, 429].includes(status) || status >= 500);
      if (status === 429) assert.equal(loop.getRetryDelay(e, 0), 7000);
      return true;
    });
  });
}

test("early SSE honors date-form Retry-After and rejects invalid timer delays", { timeout: 5000 }, async t => {
  const now = Date.now();
  const retryAt = new Date(Math.ceil(now / 1000) * 1000 + 7000).toUTCString();
  const f = await fixture(t, res => {
    res.writeHead(429, { "retry-after": retryAt });
    res.end(JSON.stringify({ error: { message: "limited" } }));
  });
  const stream = await f.client.chat.completions.create(request);
  await assert.rejects(async () => { for await (const _ of stream) {} }, (e: unknown) => {
    t.mock.method(Date, "now", () => now);
    const loop = AgentLoop.prototype as any;
    assert.equal(loop.getRetryDelay(e, 0), Date.parse(retryAt) - now);
    const error = e as { error: { retry_after: string } };
    error.error.retry_after = "0.5";
    assert.equal(loop.getRetryDelay(e, 0), 500);
    for (const invalid of ["-1", "99999999999", "invalid", "7garbage"]) {
      error.error.retry_after = invalid;
      assert.equal(loop.getRetryDelay(e, 2), 4000);
    }
    return true;
  });
});

for (const refreshAfter401 of [false, true]) {
  test(`credential refresh ${refreshAfter401 ? "after 401" : "before request"} respects the request deadline`, { timeout: 5000 }, async t => {
    const pending = () => new Promise<null>(() => {});
    const f = await fixture(t, res => { res.writeHead(401); res.end(); }, {
      headersTimeoutMs: 80, credentialsTimeoutMs: 80,
      ...(refreshAfter401 ? { refreshCredentials: pending } : { getCredentials: pending }),
    });
    const response = await fetch(f.proxy.baseURL + "/chat/completions", {
      method: "POST", headers: { authorization: "Bearer test-only", "content-type": "application/json" },
      body: JSON.stringify(request), signal: AbortSignal.timeout(500),
    });
    assert.equal(response.status, refreshAfter401 ? 200 : 504);
    assert.match(await response.text(), /timed out/);
    assert.equal(f.requests(), refreshAfter401 ? 1 : 0);
  });

  test(`cancelling a caller ${refreshAfter401 ? "after 401" : "before request"} preserves shared credential refresh`, { timeout: 5000 }, async t => {
    let release!: (value: typeof credentials) => void;
    const shared = new Promise<typeof credentials>(resolve => { release = resolve; });
    let waiting = 0, ready!: () => void, upstreamCalls = 0;
    const bothWaiting = new Promise<void>(resolve => { ready = resolve; });
    const refresh = () => { if (++waiting === 2) ready(); return shared; };
    const f = await fixture(t, res => {
      if (refreshAfter401 && ++upstreamCalls <= 2) { res.writeHead(401); res.end(); }
      else { start(res); finish(res); }
    }, refreshAfter401 ? { refreshCredentials: refresh } : { getCredentials: refresh });
    const cancel = new AbortController();
    const first = fetch(f.proxy.baseURL + "/chat/completions", {
      method: "POST", headers: { authorization: "Bearer test-only", "content-type": "application/json" },
      body: JSON.stringify(request), signal: cancel.signal,
    });
    const second = f.raw();
    await bothWaiting;
    cancel.abort();
    // Once SSE has been acknowledged, cancellation rejects body consumption
    // rather than the already-resolved fetch promise.
    await assert.rejects(first.then(response => response.text()), { name: "AbortError" });
    // Give the server's close event a chance to release the first waiter.
    await delay(30);
    release(credentials);
    const response = await second;
    assert.equal(response.status, 200);
    assert.match(await response.text(), /\[DONE\]/);
    assert.equal(f.requests(), refreshAfter401 ? 3 : 1, "cancelled caller must not resume upstream work");
  });
}

test("non-streaming aggregation also times out and cancels a silent upstream", { timeout: 5000 }, async t => {
  const f = await fixture(t, start, { idleTimeoutMs: 120 });
  const response = await f.raw(false);
  assert.equal(response.status, 504);
  assert.match((await response.json()).error.message, /waiting for stream data/);
  await f.closed;
});

test("caller cancellation cancels upstream while no translated output is available", { timeout: 5000 }, async t => {
  const f = await fixture(t, start);
  const controller = new AbortController();
  const stream = await f.client.chat.completions.create(request, { signal: controller.signal });
  controller.abort();
  try { for await (const _ of stream) { /* drain */ } } catch { /* SDK abort */ }
  await f.closed;
  assert.equal(f.requests(), 1);
});

test("closing the proxy cancels active streams and resolves promptly", { timeout: 5000 }, async t => {
  const f = await fixture(t, start);
  const response = await f.raw();
  const body = response.text().catch(() => "closed");
  while (!f.requests()) await delay(5);
  await f.proxy.close();
  await f.closed;
  await body;
});

test("upstream failure after partial content remains an SDK error", { timeout: 5000 }, async t => {
  const f = await fixture(t, res => {
    start(res);
    event(res, { type: "response.output_text.delta", delta: "partial" });
    event(res, { type: "response.failed", response: { error: { message: "upstream failed" } } });
    res.end();
  });
  const stream = await f.client.chat.completions.create(request);
  let content = "";
  await assert.rejects(async () => {
    for await (const chunk of stream) content += chunk.choices[0]?.delta.content ?? "";
  }, /upstream failed/);
  assert.equal(content, "partial");
});


test("a truncated upstream stream cannot masquerade as a completed answer", { timeout: 5000 }, async t => {
  const f = await fixture(t, res => {
    start(res);
    event(res, { type: "response.output_text.delta", delta: "partial" });
    res.end();
  });
  const stream = await f.client.chat.completions.create(request);
  await assert.rejects(async () => { for await (const _ of stream) { /* drain */ } }, /ended before completion/);
});

test("an upstream socket failure surfaces after headers and releases the request", { timeout: 5000 }, async t => {
  const f = await fixture(t, res => {
    start(res);
    const timer = setTimeout(() => res.destroy(), 60);
    res.on("close", () => clearTimeout(timer));
  });
  const stream = await f.client.chat.completions.create(request);
  await assert.rejects(async () => { for await (const _ of stream) { /* drain */ } });
  await f.closed;
});

for (const type of ["response.completed", "response.done", "response.incomplete"]) {
  for (const stream of [true, false]) {
    test(`${type} finishes ${stream ? "streaming" : "aggregated"} replies without waiting for upstream EOF`, { timeout: 5000 }, async t => {
      const f = await fixture(t, res => {
        start(res);
        event(res, { type: "response.output_text.delta", delta: "finished" });
        event(res, { type, response: {
          status: type === "response.incomplete" ? "incomplete" : "completed",
          usage: { input_tokens: 4, output_tokens: 2 },
        } });
        // The application-level terminal event is authoritative even if a
        // gateway keeps the HTTP body open or fails while closing it.
      }, { idleTimeoutMs: 120 });
      const response = await f.raw(stream);
      assert.equal(response.status, 200);
      const text = await response.text();
      assert(!text.includes('"error"'), text);
      assert(text.includes("finished"));
      assert(text.includes('"total_tokens":6'));
      assert(text.includes(`"finish_reason":"${type === "response.incomplete" ? "length" : "stop"}"`));
      if (stream) assert(text.includes("[DONE]"));
      await f.closed;
    });
  }
}
