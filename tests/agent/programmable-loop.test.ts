import test from "node:test";
import assert from "node:assert/strict";
import { AgentLoop, type AgentRunMessage } from "../../src/agent/agent-loop.js";
import type { LlmClient } from "../../src/agent/llm-client.js";
import { EventBus } from "../../src/core/event-bus.js";
import { HandlerRegistry } from "../../src/utils/handler-registry.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const call = (name = "probe", id = "call-1") => ({ index: 0, id, type: "function", function: { name, arguments: '{"path":"file"}' } });
function harness(rounds: Array<{ text?: string; calls?: ReturnType<typeof call>[]; tokens?: number; error?: string }> = [], ambientContext?: boolean) {
  const handlers = new HandlerRegistry();
  const bus = new EventBus();
  const cache = new Map();
  handlers.define("cwd", () => "/tmp/agent-loop-cwd");
  handlers.define("dynamic-context:build", () => "");
  handlers.define("agent:file-read-cache", () => cache);
  handlers.define("config:settings", () => ({ get: () => ({ toolMode: "api", autoCompact: false, thinkingLevel: "off" }) }));
  const requests: any[] = [];
  const llmClient = {
    model: "fake-model",
    async stream(request: any) {
      requests.push(structuredClone({ ...request, signal: undefined }));
      const round = rounds[requests.length - 1] ?? { text: "done" };
      if (round.error) throw new Error(round.error);
      return (async function* () {
        yield { choices: [{ delta: { content: round.text ?? "", tool_calls: round.calls } }] };
        yield { choices: [], usage: { prompt_tokens: 10, completion_tokens: round.tokens ?? 2, total_tokens: 10 + (round.tokens ?? 2) } };
      })();
    },
  } as unknown as LlmClient;
  const loop = new AgentLoop({ handlers, bus, llmClient, ambientContext });
  loop.registerTool({ name: "probe", description: "test", input_schema: {},
    execute: async () => ({ content: "tool result", exitCode: 0, isError: false }) });
  return { loop, handlers, bus, requests, cache, llmClient };
}
const options = { systemPrompt: "test system", dynamicContext: "test context" };

test("direct unwired run uses the real multi-round engine, advice, callbacks and wire history", async () => {
  const { loop, handlers, requests } = harness([{ text: "working", calls: [call()] }, { text: "answer" }]);
  const order: string[] = [];
  handlers.advise("tool:execute", async (next, ctx) => { order.push("policy"); return next(ctx); });
  handlers.advise("tool:probe", async (next, ...args) => { order.push("tool"); assert.ok(args[2].signal); return next(...args); });
  const messages: AgentRunMessage[] = [];
  const usage: unknown[] = [];
  const result = await loop.run("query", { ...options, runId: "known", onMessage: m => messages.push(m), onUsage: u => usage.push(u) });
  assert.equal(result.runId, "known");
  assert.equal(result.stopReason, "completed");
  assert.equal(result.text, "workinganswer");
  assert.equal(result.finalText, "answer");
  assert.equal(result.iterations, 2);
  assert.deepEqual(result.usage, { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 });
  assert.deepEqual(order, ["policy", "tool"]);
  assert.deepEqual(messages.map(m => m.role), ["user", "assistant", "tool", "assistant"]);
  assert.deepEqual(messages[1].toolCalls, [{ name: "probe", arguments: '{"path":"file"}' }]);
  assert.equal(usage.length, 2);
  assert.equal(requests[0].messages[0].content, options.systemPrompt);
  assert.match(JSON.stringify(requests[0].messages), /test context/);
  assert.equal(result.messages[2].role, "tool");
  assert.deepEqual(loop.snapshot().messages, result.messages);
  await loop.dispose();
});

for (const limit of ["iterations", "budget", "shouldStop"] as const) {
  test(`limits: ${limit} stops after a complete tool batch`, async () => {
    const { loop, requests } = harness([{ text: "round", calls: [call()], tokens: 3 }]);
    const result = await loop.run("query", { ...options,
      ...(limit === "iterations" ? { maxIterations: 1 } : limit === "budget" ? { budgetTokens: 3 } : { shouldStop: () => true }),
    });
    assert.equal(result.stopReason, "limited");
    assert.equal(result.limit, limit);
    assert.equal(requests.length, 1);
    assert.equal(result.messages.at(-1)?.role, "tool");
    if (limit === "budget") assert.equal(requests[0].max_tokens, 3);
    await loop.dispose();
  });
}

test("zero limits and pre-cancelled signals make no model requests", async () => {
  const { loop, requests } = harness();
  assert.equal((await loop.run("query", { ...options, maxIterations: 0 })).stopReason, "limited");
  assert.equal((await loop.run("query", { ...options, budgetTokens: 0 })).limit, "budget");
  assert.equal((await loop.run("query", { ...options, signal: AbortSignal.abort() })).stopReason, "cancelled");
  assert.equal(requests.length, 0);
  await loop.dispose();
});

test("busy, cancellation and awaitable dispose work even with an uncooperative model", async () => {
  const { loop, llmClient } = harness();
  let started!: () => void;
  const ready = new Promise<void>(r => { started = r; });
  llmClient.stream = async () => { started(); return new Promise(() => {}); };
  const controller = new AbortController();
  const running = loop.run("query", { ...options, signal: controller.signal });
  await assert.rejects(loop.run("overlap"), /busy/);
  assert.throws(() => loop.snapshot(), /busy/);
  assert.throws(() => loop.restore({ version: 1, messages: [] }), /busy/);
  await ready;
  controller.abort();
  assert.equal((await running).stopReason, "cancelled");
  await loop.dispose();
  await assert.rejects(loop.run("later"), /disposed/);
});

test("dispose immediately after run also cancels the reserved run", async () => {
  const { loop, requests } = harness();
  const running = loop.run("query", options);
  await loop.dispose();
  assert.equal((await running).stopReason, "cancelled");
  assert.equal(requests.length, 0);
});

test("named runtime handlers, snapshot versioning, defensive history copying and instance isolation", async () => {
  const a = harness();
  const b = harness();
  a.loop.wire();
  const history = [{ role: "user" as const, content: "seed" }];
  const first = await a.handlers.call("agent:run", { query: "a", ...options, history });
  assert.equal(history.length, 1);
  const snapshot = a.handlers.call("agent:snapshot");
  b.loop.restore(snapshot);
  snapshot.messages[0].content = "changed";
  assert.equal(b.loop.snapshot().messages[0].content, "seed");
  assert.throws(() => b.loop.restore({ version: 2, messages: [] } as any), /snapshot/);
  const second = await b.loop.run("b", options);
  assert.equal(first.messages.length + 2, second.messages.length);
  assert.notEqual(first.runId, second.runId);
  assert.equal(a.loop.snapshot().messages.length, first.messages.length);
  await a.handlers.call("agent:dispose");
  await b.loop.dispose();
});

test("injected dispatch stays inside policy; mutations invalidate the runtime cwd cache", async () => {
  const { loop, handlers, cache } = harness([{ calls: [call("write")] }]);
  const order: string[] = [];
  loop.registerTool({ name: "write", description: "write", input_schema: {}, modifiesFiles: true,
    execute: async () => { throw new Error("registry should not be used by injected dispatcher"); } });
  cache.set("/tmp/agent-loop-cwd/file", {});
  handlers.define("tool:dispatch", async (ctx) => {
    order.push("dispatch"); assert.ok(ctx.context.signal);
    return { content: "written", exitCode: 0, isError: false };
  });
  handlers.advise("tool:execute", (next, ctx) => { order.push("policy"); return next(ctx); });
  const result = await loop.run("query", options);
  assert.deepEqual(order, ["policy", "dispatch"]);
  assert.equal(result.mutatingToolExecuted, true);
  assert.equal(cache.size, 0);
  await loop.dispose();
});

test("parallel tool completion order does not reorder wire results or message callbacks", async () => {
  const second = { ...call("fast", "call-2"), index: 1 };
  const { loop } = harness([{ calls: [call("slow"), second] }, { text: "final" }]);
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  loop.registerTool({ name: "slow", description: "slow", input_schema: {}, execute: async () => {
    await gate; return { content: "slow", exitCode: 0, isError: false };
  } });
  loop.registerTool({ name: "fast", description: "fast", input_schema: {}, execute: async () => {
    release(); return { content: "fast", exitCode: 0, isError: false };
  } });
  const messages: AgentRunMessage[] = [];
  const result = await loop.run("query", { ...options, onMessage: m => messages.push(m) });
  assert.deepEqual(result.messages.filter(m => m.role === "tool").map(m => m.tool_call_id), ["call-1", "call-2"]);
  assert.deepEqual(messages.filter(m => m.role === "tool").map(m => m.toolName), ["slow", "fast"]);
  await loop.dispose();
});

test("cancelling a running tool passes its signal and leaves resumable history", async () => {
  const { loop } = harness([{ calls: [call("waiting")] }]);
  let started!: () => void;
  let toolSignal: AbortSignal | undefined;
  const ready = new Promise<void>(r => { started = r; });
  loop.registerTool({ name: "waiting", description: "waiting", input_schema: {}, execute: async (_args, _chunk, ctx) => {
    toolSignal = ctx?.signal; started(); return new Promise(() => {});
  } });
  const controller = new AbortController();
  const running = loop.run("query", { ...options, signal: controller.signal });
  await ready;
  controller.abort();
  const result = await running;
  assert.equal(result.stopReason, "cancelled");
  assert.equal(toolSignal?.aborted, true);
  assert.equal(result.messages.at(-1)?.role, "tool");
  assert.equal((await loop.run("continue", options)).stopReason, "completed");
  await loop.dispose();
});

test("bus cancellation can abort a run before its first microtask", async () => {
  const { loop, bus, requests } = harness();
  loop.wire();
  const running = loop.run("query", options);
  bus.emit("agent:cancel-request", {});
  assert.equal((await running).stopReason, "cancelled");
  assert.equal(requests.length, 0);
  await loop.dispose();
});

test("instance settings supply live thinking and reasoning overrides cannot replace core request fields", async () => {
  const { loop, handlers, requests } = harness();
  handlers.define("config:settings", () => ({ get: () => ({ autoCompact: false, thinkingLevel: "high" }) }));
  await loop.run("query", options);
  assert.equal(requests[0].reasoning_effort, "high");
  await loop.run("query", { ...options, budgetTokens: 5, reasoningParams: { model: "wrong", messages: [], max_tokens: 999, reasoning_effort: "low" } });
  assert.equal(requests[1].model, "fake-model");
  assert.equal(requests[1].max_tokens, 5);
  assert.ok(requests[1].messages.length);
  assert.equal(requests[1].reasoning_effort, "low");
  await loop.dispose();
});

test("model failures return failed results rather than success inferred from done events", async () => {
  const { loop, bus } = harness([{ error: "bad request" }]);
  let done = 0;
  bus.on("agent:processing-done", () => { done++; });
  const result = await loop.run("query", options);
  assert.equal(result.stopReason, "failed");
  assert.match(result.error!, /bad request/);
  assert.equal(done, 1);
  await loop.dispose();
});

for (const boundary of ["llm:request", "agent:tool-started"] as const) {
  test(`cancellation at ${boundary} does not start transport/dispatch`, async () => {
    const { loop, bus, handlers, requests } = harness([{ calls: [call()] }]);
    const controller = new AbortController();
    let dispatched = 0;
    handlers.define("tool:dispatch", () => { dispatched++; throw new Error("must not start"); });
    bus.on(boundary, () => controller.abort());
    const result = await loop.run("query", { ...options, signal: controller.signal });
    assert.equal(result.stopReason, "cancelled");
    assert.equal(dispatched, 0);
    assert.equal(result.mutatingToolExecuted, false);
    assert.equal(requests.length, boundary === "llm:request" ? 0 : 1);
    await loop.dispose();
  });
}

for (const operation of ["stream", "dispatch"] as const) {
  test(`a ${operation} that aborts synchronously and rejects is still observed`, async () => {
    const { loop, handlers, llmClient } = harness([{ calls: [call()] }]);
    const controller = new AbortController();
    const rejectAfterAbort = () => { controller.abort(); return Promise.reject(new Error("late rejection")); };
    if (operation === "stream") llmClient.stream = rejectAfterAbort;
    else handlers.define("tool:dispatch", rejectAfterAbort);
    assert.equal((await loop.run("query", { ...options, signal: controller.signal })).stopReason, "cancelled");
    await new Promise(resolve => setImmediate(resolve));
    await loop.dispose();
  });
}

for (const event of ["agent:submit", "agent:steer"] as const) {
  test(`idle ${event} announces startup synchronously and processing-done can reenter`, async () => {
    const { loop, bus } = harness([{ text: "first" }, { calls: [call()] }, { text: "wake answer" }]);
    loop.wire();
    let starts = 0;
    let cancellations = 0;
    let turns = 0;
    bus.on("agent:processing-start", () => { starts++; });
    bus.on("agent:cancelled", () => { cancellations++; });
    const finished = new Promise<void>(resolve => {
      bus.on("agent:processing-done", () => {
        if (++turns === 1) {
          bus.emit(event, event === "agent:submit" ? { query: "wake" } : { text: "wake" });
          assert.equal(starts, 2);
        } else resolve();
      });
    });
    bus.emit("agent:submit", { query: "first" });
    assert.equal(starts, 1);
    await finished;
    assert.equal(cancellations, 0);
    assert.equal(loop.snapshot().messages.at(-1)?.content, "wake answer");
    assert.equal(loop.snapshot().messages.filter(m => m.role === "tool").length, 1);
    await loop.dispose();
  });
}

test("unwire releases only its callable handlers and preserves newer owners", async () => {
  const { loop, handlers } = harness();
  handlers.define("agent:run", () => "previous");
  loop.wire();
  loop.unwire();
  assert.equal(handlers.call("agent:run"), "previous");
  for (const name of ["agent:dispose", "agent:snapshot", "agent:restore", "agent:steer-active"]) assert.ok(!handlers.list().includes(name));
  loop.wire();
  handlers.define("agent:run", () => "new backend");
  loop.unwire();
  assert.equal(handlers.call("agent:run"), "new backend");
  await loop.dispose();
});

test("active-only steering accepts reserved and streaming runs, never completing or idle turns", async () => {
  const { loop, handlers, bus, requests } = harness([{ text: "first" }, { text: "answer" }]);
  loop.wire();
  const steer = (text: string) => handlers.call("agent:steer-active", text);
  assert.equal(steer("idle"), false);
  let streamed = false;
  bus.on("agent:response-chunk", () => {
    if (!streamed) { streamed = true; assert.equal(steer("streaming"), true); }
  });
  const completionAttempts: boolean[] = [];
  bus.on("agent:response-done", () => { completionAttempts.push(steer("completing")); });
  bus.on("agent:processing-done", () => {
    completionAttempts.push(steer("done"));
    // The programmable host can still own its promise until the next microtask.
    queueMicrotask(() => { completionAttempts.push(steer("queued at completion")); });
  });
  const running = handlers.call("agent:run", { query: "query", ...options });
  assert.equal(steer("reserved"), true);
  const result = await running;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(result.stopReason, "completed");
  assert.deepEqual(completionAttempts, [false, false, false]);
  assert.equal(requests.length, 2);
  assert.deepEqual(result.messages.filter(m => m.role === "user").map(m => m.content), ["query", "reserved", "streaming"]);
  assert.equal(steer("after"), false);
  await loop.dispose();
});

test("active-only steering rejects an aborted reservation without starting another run", async () => {
  const { loop, handlers, bus, requests } = harness();
  loop.wire();
  const running = loop.run("query", options);
  bus.emit("agent:cancel-request", {});
  assert.equal(handlers.call("agent:steer-active", "cancelled"), false);
  assert.equal((await running).stopReason, "cancelled");
  assert.equal(requests.length, 0);
  await loop.dispose();
});

test("pipe tools fall back only when the named handler is absent", async () => {
  const { loop, bus, handlers } = harness([{ calls: [call("pipe")] }, { text: "done" }, { calls: [call("pipe")] }]);
  let executions = 0;
  bus.onPipe("agent:tools", acc => {
    acc.tools.push({ name: "pipe", description: "pipe", input_schema: {}, execute: async () => {
      executions++; return { content: "pipe result", exitCode: 0, isError: false };
    } });
    return acc;
  });
  assert.equal((await loop.run("query", options)).stopReason, "completed");
  handlers.define("tool:pipe", () => undefined);
  const result = await loop.run("query", { ...options, throwToolErrors: true, rawErrors: true });
  assert.equal(executions, 1);
  assert.equal(result.stopReason, "failed");
  assert.equal(result.error, 'Tool "pipe" returned no result');
  await loop.dispose();
});

test("legacy error options preserve thrown tool and model failures", async () => {
  const { loop, handlers } = harness([{ calls: [call()] }, { error: "original model failure" }]);
  handlers.define("tool:probe", () => { throw new Error("original tool failure"); });
  const result = await loop.run("query", { ...options, throwToolErrors: true, rawErrors: true });
  assert.equal(result.stopReason, "failed");
  assert.equal(result.error, "original tool failure");
  assert.equal((await loop.run("query", { ...options, rawErrors: true })).error, "original model failure");
  await loop.dispose();
});

test("ambient context defaults on but can be disabled without losing explicit instructions", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "agent-loop-ambient-"));
  writeFileSync(join(cwd, "AGENT.md"), "UNIQUE_PROJECT_RULE");
  try {
    for (const ambient of [undefined, false]) {
      const { loop, handlers, bus, requests } = harness([], ambient);
      handlers.define("cwd", () => cwd);
      loop.wire();
      loop.registerInstruction("explicit", "EXPLICIT_EXTENSION_RULE", "test");
      bus.emit("shell:cwd-change", { cwd });
      await loop.run("query", { dynamicContext: "" });
      const system = requests[0].messages[0].content;
      assert.equal(system.includes("UNIQUE_PROJECT_RULE"), ambient !== false);
      assert.match(system, /EXPLICIT_EXTENSION_RULE/);
      await loop.dispose();
    }
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
