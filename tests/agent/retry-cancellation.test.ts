import { test } from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { AgentLoop } from "../../src/agent/agent-loop.js";
import { EventBus } from "../../src/core/event-bus.js";

function limited(retryAfter: string) {
  return Object.assign(new Error("rate limited"), {
    type: "codex_proxy_error", error: { status: 429, retryable: true, retry_after: retryAfter },
  });
}

// Exercise the real retry loop, substituting only the model request.
function harness(streamResponse: () => Promise<unknown>) {
  const bus = new EventBus();
  const loop = Object.assign(Object.create(AgentLoop.prototype), { bus, maxRetries: 3, streamResponse });
  return { bus, run: (signal: AbortSignal) => loop.streamWithRetry("", "", signal) as Promise<unknown> };
}

test("cancellation on retry announcement does not wait or start another request", async () => {
  const controller = new AbortController();
  let calls = 0;
  const { bus, run } = harness(async () => {
    if (++calls === 1) throw limited("0.03");
    return "unexpected retry";
  });
  bus.on("ui:info", () => controller.abort());
  await assert.rejects(run(controller.signal), /abort/i);
  assert.equal(calls, 1);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("cancellation interrupts a long backoff and cleans up its listener", async () => {
  const controller = new AbortController();
  let calls = 0;
  const { bus, run } = harness(async () => { calls++; throw limited("30"); });
  bus.on("ui:info", () => queueMicrotask(() => controller.abort()));
  await assert.rejects(run(controller.signal), /abort/i);
  assert.equal(calls, 1);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

for (const exhausted of [false, true]) {
  test(`retry waits release listeners after ${exhausted ? "exhaustion" : "recovery"}`, async () => {
    const controller = new AbortController();
    const existing = () => {};
    controller.signal.addEventListener("abort", existing);
    let calls = 0;
    const { run } = harness(async () => {
      if (++calls <= 3 || exhausted) throw limited("0");
      return "recovered";
    });
    if (exhausted) await assert.rejects(run(controller.signal), /rate limited/);
    else assert.equal(await run(controller.signal), "recovered");
    assert.equal(calls, 4);
    assert.deepEqual(getEventListeners(controller.signal, "abort"), [existing]);
  });
}
