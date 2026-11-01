import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentHost, HostExtension } from "../../src/runtime/index.js";
import type { BusEvents } from "../../src/core/event-bus.js";
import type { ExtensionContext } from "../../src/shell/host-types.js";

// Set this before importing runtime: never read the user's settings or credentials.
const previousHome = process.env.AGENT_SH_HOME;
const testHome = mkdtempSync(join(tmpdir(), "agent-sh-runtime-test-"));
process.env.AGENT_SH_HOME = testHome;
after(() => {
  if (previousHome === undefined) delete process.env.AGENT_SH_HOME;
  else process.env.AGENT_SH_HOME = previousHome;
  rmSync(testHome, { recursive: true, force: true });
});
const { createAgentHost } = await import("../../src/runtime/index.js");

const zeroUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

function fakeBackend(options: {
  synchronous?: boolean;
  holdCancellation?: boolean;
  startError?: Error;
  killError?: Error;
} = {}) {
  let ctx: ExtensionContext;
  const state = {
    starts: 0,
    kills: 0,
    submissions: [] as BusEvents["agent:submit"][],
    cancellations: [] as BusEvents["agent:cancel-request"][],
    steering: [] as string[],
    cwds: [] as string[],
  };
  const complete = (text: string) => {
    ctx.bus.emit("agent:response-done", { response: text });
    ctx.bus.emit("agent:processing-done", {});
  };
  const cancelled = () => {
    ctx.bus.emit("agent:cancelled", {});
    ctx.bus.emit("agent:processing-done", {});
  };
  const extension: HostExtension = {
    name: "fake-backend",
    activate(context) {
      ctx = context;
      ctx.bus.on("agent:submit", (event) => {
        state.submissions.push(event);
        state.cwds.push(ctx.call("cwd"));
        ctx.bus.emit("agent:processing-start", {});
        if (options.synchronous) {
          ctx.bus.emit("agent:usage", { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 });
          ctx.bus.emit("agent:usage", { prompt_tokens: 7, completion_tokens: 11, total_tokens: 18 });
          // Exercise existing advice through the same context a real backend uses.
          complete(`${ctx.call("query-context:build", event.query)}reply:${event.query}`);
        }
      });
      ctx.bus.on("agent:steer", ({ text }) => { state.steering.push(text); });
      ctx.bus.on("agent:cancel-request", (event) => {
        state.cancellations.push(event);
        if (!options.holdCancellation) queueMicrotask(cancelled);
      });
      ctx.bus.emit("agent:register-backend", {
        name: "fake",
        start: async () => {
          state.starts++;
          if (options.startError) throw options.startError;
        },
        kill: () => {
          state.kills++;
          if (options.killError) throw options.killError;
        },
      });
    },
  };
  return { extension, state, complete, cancelled };
}

function probeExtension(name: string, disposed: string[] = []) {
  let ctx: ExtensionContext;
  const calls = { event: 0, pipe: 0, asyncPipe: 0, any: 0, dispose: 0 };
  const extension: HostExtension = {
    name,
    activate(context) {
      ctx = context;
      ctx.bus.on("ui:info", () => { calls.event++; });
      ctx.bus.onPipe("ui:suggestion", ({ text }) => {
        calls.pipe++;
        return { text: `${text}:sync` };
      });
      ctx.bus.onPipeAsync("ui:suggestion", async ({ text }) => {
        await Promise.resolve();
        calls.asyncPipe++;
        return { text: `${text}:async` };
      });
      ctx.bus.onAny((event) => { if (event === "ui:info") calls.any++; });
      ctx.advise("dynamic-context:build", (next) => `${next()}advised`);
      ctx.onDispose(() => {
        calls.dispose++;
        disposed.push(name);
      });
    },
  };
  return { extension, calls, context: () => ctx };
}

async function assertProbeRemoved(probe: ReturnType<typeof probeExtension>) {
  const ctx = probe.context();
  const before = { ...probe.calls };
  ctx.bus.emit("ui:info", { message: "after teardown" });
  assert.deepEqual(ctx.bus.emitPipe("ui:suggestion", { text: "plain" }), { text: "plain" });
  assert.deepEqual(await ctx.bus.emitPipeAsync("ui:suggestion", { text: "plain" }), { text: "plain" });
  assert.equal(ctx.call("dynamic-context:build"), "");
  assert.deepEqual(probe.calls, before, "disposed registrations must not run");
  assert.equal(probe.calls.dispose, 1);
}

// Ensure failed assertions cannot leave a manually controlled run pending.
function cleanupHost(t: { after(fn: () => Promise<void>): void }, host: AgentHost, backend: ReturnType<typeof fakeBackend>) {
  t.after(async () => {
    backend.cancelled();
    await host.dispose();
  });
}

test("captures synchronous responses and sums usage before submit returns", async (t) => {
  const backend = fakeBackend({ synchronous: true });
  const host = await createAgentHost({ cwd: testHome, config: { backend: "fake" }, extensions: [backend.extension] });
  cleanupHost(t, host, backend);
  assert.equal(backend.state.starts, 1);
  assert.equal(host.context.instanceId, host.id);
  assert.deepEqual(host.context.bus.emitPipe("config:get-backends", { names: [], active: null }), {
    names: ["fake"], active: "fake",
  });
  assert.deepEqual(await host.run("hello"), {
    text: "reply:hello", status: "completed",
    usage: { prompt_tokens: 9, completion_tokens: 14, total_tokens: 23 },
  });
  assert.deepEqual(await host.run("again"), {
    text: "reply:again", status: "completed",
    usage: { prompt_tokens: 9, completion_tokens: 14, total_tokens: 23 },
  });
  assert.equal(backend.state.submissions.length, 2);
});

test("rejects busy runs, forwards steering, and waits for cooperative cancellation", async (t) => {
  const backend = fakeBackend({ holdCancellation: true });
  const host = await createAgentHost({ cwd: testHome, extensions: [backend.extension] });
  cleanupHost(t, host, backend);
  assert.throws(() => host.steer("idle"), /Steering requires an active run/);
  const controller = new AbortController();
  const pending = host.run("wait", { signal: controller.signal });
  let settled = false;
  void pending.then(() => { settled = true; });
  await assert.rejects(host.run("overlap"), /Agent host is busy/);
  host.steer("change direction");
  assert.deepEqual(backend.state.steering, ["change direction"]);
  controller.abort();
  assert.deepEqual(backend.state.cancellations, [{ silent: false }]);
  await Promise.resolve();
  assert.equal(settled, false, "abort requests cancellation; the backend must acknowledge it");
  await assert.rejects(host.run("still busy"), /Agent host is busy/);
  backend.cancelled();
  assert.deepEqual(await pending, { text: "", status: "cancelled", usage: zeroUsage });
  const next = host.run("next");
  host.cancel();
  backend.cancelled();
  assert.equal((await next).status, "cancelled");
  assert.equal(backend.state.cancellations.length, 2);
  assert.equal(backend.state.submissions.length, 2);
});

test("abort from a submit observer is replayed after the backend installs its run controller", async (t) => {
  const controller = new AbortController();
  let runController: AbortController | undefined;
  const cancellations: boolean[] = [];
  const observer: HostExtension = {
    name: "abort-observer",
    activate(ctx) {
      ctx.bus.on("agent:submit", () => { controller.abort(); });
    },
  };
  const backend: HostExtension = {
    name: "late-controller-backend",
    activate(ctx) {
      ctx.bus.on("agent:cancel-request", () => {
        cancellations.push(runController !== undefined);
        runController?.abort();
      });
      ctx.bus.on("agent:submit", () => {
        runController = new AbortController();
        runController.signal.addEventListener("abort", () => {
          queueMicrotask(() => {
            ctx.bus.emit("agent:cancelled", {});
            ctx.bus.emit("agent:processing-done", {});
          });
        }, { once: true });
        ctx.bus.emit("agent:processing-start", {});
      });
      ctx.bus.emit("agent:register-backend", { name: "late-controller", kill() {} });
    },
  };
  const host = await createAgentHost({ cwd: testHome, extensions: [observer, backend] });
  t.after(async () => {
    host.context.bus.emit("agent:processing-done", {});
    await host.dispose();
  });
  const pending = host.run("abort before backend listener", { signal: controller.signal });
  assert.deepEqual(cancellations, [false, true]);
  assert.equal(runController?.signal.aborted, true);
  assert.deepEqual(await pending, { text: "", status: "cancelled", usage: zeroUsage });
});

test("an already aborted signal does not submit or occupy the host", async (t) => {
  const backend = fakeBackend({ synchronous: true });
  const host = await createAgentHost({ cwd: testHome, extensions: [backend.extension] });
  cleanupHost(t, host, backend);
  const controller = new AbortController();
  controller.abort();
  assert.deepEqual(await host.run("skip", { signal: controller.signal }), {
    text: "", status: "cancelled", usage: zeroUsage,
  });
  assert.equal(backend.state.submissions.length, 0);
  assert.equal((await host.run("go")).status, "completed");
});

test("two concurrent hosts isolate cwd, events, results, and cancellation", async (t) => {
  const processCwd = process.cwd();
  const left = fakeBackend({ holdCancellation: true });
  const right = fakeBackend();
  const [a, b] = await Promise.all([
    createAgentHost({ cwd: join(testHome, "left"), extensions: [left.extension] }),
    createAgentHost({ cwd: join(testHome, "right"), extensions: [right.extension] }),
  ]);
  cleanupHost(t, a, left);
  cleanupHost(t, b, right);
  assert.notEqual(a.id, b.id);
  const eventsA: string[] = [];
  const eventsB: string[] = [];
  const offA = a.context.bus.onAny((name, _payload, meta) => {
    if (name.startsWith("agent:")) eventsA.push(meta.source);
  });
  const offB = b.context.bus.onAny((name, _payload, meta) => {
    if (name.startsWith("agent:")) eventsB.push(meta.source);
  });
  t.after(() => { offA(); offB(); });
  const runA = a.run("A");
  const runB = b.run("B");
  let bSettled = false;
  void runB.then(() => { bSettled = true; });
  a.cancel();
  left.cancelled();
  assert.equal((await runA).status, "cancelled");
  assert.equal(bSettled, false);
  assert.deepEqual(right.state.cancellations, []);
  b.context.bus.emit("agent:usage", { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 });
  right.complete("only B");
  assert.deepEqual(await runB, {
    text: "only B", status: "completed", usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
  });
  assert.deepEqual(left.state.cwds, [join(testHome, "left")]);
  assert.deepEqual(right.state.cwds, [join(testHome, "right")]);
  assert.equal(process.cwd(), processCwd);
  assert.ok(eventsA.length > 0 && eventsA.every((source) => source === a.id));
  assert.ok(eventsB.length > 0 && eventsB.every((source) => source === b.id));
  await a.dispose();
  const again = b.run("still alive");
  right.complete("independent");
  assert.equal((await again).text, "independent");
  assert.equal(right.state.kills, 0);
});

test("dispose waits for cancellation, kills once, and removes extension registrations", async (t) => {
  const backend = fakeBackend({ holdCancellation: true });
  const order: string[] = [];
  const first = probeExtension("first", order);
  const second = probeExtension("second", order);
  const host = await createAgentHost({ cwd: testHome, extensions: [backend.extension, first.extension, second.extension] });
  cleanupHost(t, host, backend);
  host.context.bus.emit("ui:info", { message: "before teardown" });
  assert.deepEqual(host.context.bus.emitPipe("ui:suggestion", { text: "x" }), { text: "x:sync:sync" });
  assert.deepEqual(await host.context.bus.emitPipeAsync("ui:suggestion", { text: "x" }), { text: "x:async:async" });
  assert.equal(first.calls.event, 1);
  assert.equal(first.calls.any, 1);
  assert.equal(first.calls.pipe, 1);
  assert.equal(first.calls.asyncPipe, 1);
  assert.equal(host.context.call("dynamic-context:build"), "advisedadvised");
  const pending = host.run("dispose me");
  const disposal = host.dispose();
  assert.strictEqual(host.dispose(), disposal);
  await Promise.resolve();
  assert.equal(backend.state.kills, 0);
  assert.deepEqual(order, []);
  assert.deepEqual(backend.state.cancellations, [{ silent: false }]);
  await assert.rejects(host.run("too late"), /Agent host is disposed/);
  assert.throws(() => host.steer("too late"), /Steering requires an active run/);
  backend.cancelled();
  assert.equal((await pending).status, "cancelled");
  await disposal;
  await host.dispose();
  assert.equal(backend.state.kills, 1);
  assert.deepEqual(order, ["second", "first"]);
  await assertProbeRemoved(first);
  await assertProbeRemoved(second);
  const submissions = backend.state.submissions.length;
  host.context.bus.emit("agent:submit", { query: "after teardown" });
  assert.equal(backend.state.submissions.length, submissions);
});

test("dispose reentry through a cancellation listener calling quit does not recurse", async (t) => {
  const backend = fakeBackend({ holdCancellation: true });
  const probe = probeExtension("quit-on-cancel");
  let cancelCalls = 0;
  const host = await createAgentHost({
    cwd: testHome,
    extensions: [backend.extension, {
      name: probe.extension.name,
      async activate(ctx) {
        await probe.extension.activate(ctx);
        ctx.bus.on("agent:cancel-request", () => {
          cancelCalls++;
          // Bound a regression's recursion so the assertion reports it directly.
          if (cancelCalls === 1) ctx.quit();
        });
      },
    }],
  });
  cleanupHost(t, host, backend);
  const pending = host.run("quit on cancellation");
  const disposal = host.dispose();
  await Promise.resolve();
  assert.equal(cancelCalls, 1);
  assert.strictEqual(host.dispose(), disposal);
  assert.equal(backend.state.kills, 0);
  assert.equal(probe.calls.dispose, 0);
  backend.cancelled();
  assert.equal((await pending).status, "cancelled");
  await disposal;
  assert.equal(backend.state.kills, 1);
  assert.deepEqual(backend.state.cancellations, [{ silent: false }]);
  await assertProbeRemoved(probe);
});

test("quit during async activation waits for activation cleanup and skips the next backend", async (t) => {
  const order: string[] = [];
  const first = probeExtension("first", order);
  const late = probeExtension("late", order);
  const backend = fakeBackend();
  let nextActivations = 0;
  let activationContext!: ExtensionContext;
  let entered!: () => void;
  const activating = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const creation = createAgentHost({
    cwd: testHome,
    extensions: [first.extension, {
      name: late.extension.name,
      async activate(ctx) {
        activationContext = ctx;
        entered();
        await gate;
        await late.extension.activate(ctx);
      },
    }, {
      name: backend.extension.name,
      activate(ctx) {
        nextActivations++;
        return backend.extension.activate(ctx);
      },
    }],
  });
  let settled = false;
  const rejection = assert.rejects(creation, /Agent host quit during initialization/);
  void creation.then(() => { settled = true; }, () => { settled = true; });
  t.after(async () => {
    release();
    await creation.then((host) => host.dispose(), () => {});
  });
  await activating;
  activationContext.quit();
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  assert.equal(settled, false, "quit must wait for the in-flight activation");
  assert.deepEqual(order, [], "cleanup must not run before activation finishes");
  assert.equal(nextActivations, 0);
  release();
  await rejection;
  assert.deepEqual(order, ["late", "first"]);
  assert.equal(nextActivations, 0);
  assert.equal(backend.state.starts, 0);
  await assertProbeRemoved(first);
  await assertProbeRemoved(late);
});

test("throwing backend kill still disposes extensions and is not retried", async (t) => {
  const failure = new Error("kill failed");
  const backend = fakeBackend({ killError: failure });
  const order: string[] = [];
  const first = probeExtension("first", order);
  const second = probeExtension("second", order);
  const host = await createAgentHost({ cwd: testHome, extensions: [backend.extension, first.extension, second.extension] });
  t.after(async () => { await host.dispose().catch(() => {}); });
  const disposal = host.dispose();
  await assert.rejects(disposal, (error) => error === failure);
  assert.strictEqual(host.dispose(), disposal);
  await assert.rejects(host.dispose(), (error) => error === failure);
  assert.equal(backend.state.kills, 1);
  assert.deepEqual(order, ["second", "first"]);
  await assertProbeRemoved(first);
  await assertProbeRemoved(second);
});

test("initialization failure cleans up both prior and partially activated extensions", async () => {
  const backend = fakeBackend();
  const order: string[] = [];
  const first = probeExtension("first", order);
  const failing = probeExtension("failing", order);
  const failure = new Error("activation failed");
  await assert.rejects(createAgentHost({
    cwd: testHome,
    extensions: [backend.extension, first.extension, {
      name: failing.extension.name,
      async activate(ctx) {
        await failing.extension.activate(ctx);
        throw failure;
      },
    }],
  }), (error) => error === failure);
  assert.deepEqual(order, ["failing", "first"]);
  assert.equal(backend.state.starts, 0);
  await assertProbeRemoved(first);
  await assertProbeRemoved(failing);
});

test("backend start failure kills the backend and disposes extensions", async () => {
  const failure = new Error("start failed");
  const backend = fakeBackend({ startError: failure });
  const probe = probeExtension("probe");
  await assert.rejects(createAgentHost({
    cwd: testHome, extensions: [backend.extension, probe.extension],
  }), (error) => error === failure);
  assert.equal(backend.state.starts, 1);
  assert.equal(backend.state.kills, 1);
  await assertProbeRemoved(probe);
});

test("backend start failure preserves the original error when kill also throws", async () => {
  const failure = new Error("start failed");
  const killFailure = new Error("kill failed");
  const backend = fakeBackend({ startError: failure, killError: killFailure });
  const probe = probeExtension("probe");
  await assert.rejects(createAgentHost({
    cwd: testHome, extensions: [backend.extension, probe.extension],
  }), (error) => error === failure);
  assert.equal(backend.state.starts, 1);
  assert.equal(backend.state.kills, 1);
  await assertProbeRemoved(probe);
});

test("missing or unregistered selected backends reject and clean up", async () => {
  const probe = probeExtension("no-backend");
  await assert.rejects(createAgentHost({ cwd: testHome, extensions: [probe.extension] }), /No agent backend registered/);
  await assertProbeRemoved(probe);
  const backend = fakeBackend();
  const selectedProbe = probeExtension("unknown-backend");
  await assert.rejects(createAgentHost({
    cwd: testHome, config: { backend: "missing" }, extensions: [backend.extension, selectedProbe.extension],
  }), /Backend not registered: missing/);
  assert.equal(backend.state.starts, 0);
  await assertProbeRemoved(selectedProbe);
});

test("backend calls use advice installed by an earlier extension", async (t) => {
  const backend = fakeBackend({ synchronous: true });
  const advice: HostExtension = {
    name: "existing-advice",
    activate(ctx) {
      ctx.advise("query-context:build", (next, query) => `${next(query)}context(${query}):`);
    },
  };
  const host = await createAgentHost({ cwd: testHome, extensions: [advice, backend.extension] });
  cleanupHost(t, host, backend);
  assert.equal((await host.run("hello")).text, "context(hello):reply:hello");
  await host.dispose();
  assert.equal(host.context.call("query-context:build", "hello"), "");
});
