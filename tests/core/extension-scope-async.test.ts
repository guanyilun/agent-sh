import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { EventBus } from "../../src/core/event-bus.js";
import { HandlerRegistry } from "../../src/utils/handler-registry.js";
import { createScopedContext, extensionHostContext } from "../../src/core/extension-loader.js";
import type { ExtensionContext } from "../../src/shell/host-types.js";

function host(): ExtensionContext {
  const handlers = new HandlerRegistry();
  return {
    bus: new EventBus(), instanceId: "test", quit() {},
    getExtensionSettings: (_namespace, defaults) => defaults,
    getStoragePath: () => tmpdir(),
    define: (name, fn) => handlers.define(name, fn),
    advise: (name, fn) => handlers.advise(name, fn),
    call: (name, ...args) => handlers.call(name, ...args),
    list: () => handlers.list(),
    onDispose() {}, registerCommand() {}, adviseCommand: () => () => {},
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test("async scope teardown awaits executors before releasing their dependencies", async () => {
  const ctx = host();
  const scope = createScopedContext(ctx, "executor");
  const events: string[] = [];
  const stopped = deferred();
  const started = deferred();
  scope.scoped.define("dependency", () => "available");
  scope.scoped.onDispose(async () => {
    events.push("dependency:start");
    await Promise.resolve();
    events.push("dependency:end");
  });
  scope.scoped.onDispose(async () => {
    events.push("executor:start");
    started.resolve();
    await stopped.promise;
    assert.equal(ctx.call("dependency"), "available");
    events.push("executor:end");
  });

  const disposal = scope.disposeAsync();
  await started.promise;
  assert.deepEqual(events, ["executor:start"]);
  scope.dispose(); // Must not race the async teardown or run a cleanup twice.
  stopped.resolve();
  await disposal;
  assert.deepEqual(events, ["executor:start", "executor:end", "dependency:start", "dependency:end"]);
  assert.equal(ctx.call("dependency"), undefined);
});

test("async teardown aggregates sync and async failures without skipping remaining cleanup", async () => {
  const scope = createScopedContext(host(), "errors");
  const syncError = new Error("sync cleanup");
  const asyncError = new Error("async cleanup");
  const events: string[] = [];
  scope.scoped.onDispose(() => { events.push("last"); });
  scope.scoped.onDispose(() => { events.push("sync"); throw syncError; });
  scope.scoped.onDispose(async () => {
    events.push("async");
    await Promise.resolve();
    throw asyncError;
  });

  const disposal = scope.disposeAsync();
  await assert.rejects(disposal, error => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [asyncError, syncError]);
    return true;
  });
  assert.deepEqual(events, ["async", "sync", "last"]);
  assert.equal(scope.disposeAsync(), disposal);
  await assert.rejects(scope.disposeAsync(), AggregateError);
  scope.dispose();
  assert.deepEqual(events, ["async", "sync", "last"]);
});

test("async disposal has one stable promise for concurrent, reentrant and completed calls", async () => {
  const scope = createScopedContext(host(), "idempotent");
  let calls = 0;
  let reentrant: Promise<void> | undefined;
  scope.scoped.onDispose(() => {
    calls++;
    reentrant = scope.disposeAsync();
    scope.dispose();
  });
  const disposal = scope.disposeAsync();
  assert.equal(scope.disposeAsync(), disposal);
  await disposal;
  assert.equal(reentrant, disposal);
  assert.equal(scope.disposeAsync(), disposal);
  assert.equal(calls, 1);
});

test("async disposal after synchronous disposal awaits pending work and surfaces failures", async () => {
  const scope = createScopedContext(host(), "sync-first");
  const stopped = deferred();
  const failure = new Error("pending failure");
  const events: string[] = [];
  scope.scoped.onDispose(() => { events.push("sync"); });
  scope.scoped.onDispose(async () => {
    events.push("async:start");
    await stopped.promise;
    events.push("async:end");
    throw failure;
  });
  assert.equal(scope.dispose(), undefined);
  assert.deepEqual(events, ["async:start", "sync"]);
  scope.dispose();
  let settled = false;
  const disposal = scope.disposeAsync();
  const rejection = assert.rejects(disposal, error => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [failure]);
    return true;
  }).then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  stopped.resolve();
  await rejection;
  assert.deepEqual(events, ["async:start", "sync", "async:end"]);
});

test("async disposal retains failures that settled before it was requested", async () => {
  const scope = createScopedContext(host(), "settled");
  const failure = new Error("already rejected");
  const finished = deferred();
  let calls = 0;
  scope.scoped.onDispose(async () => {
    calls++;
    finished.resolve();
    throw failure;
  });
  scope.dispose();
  await finished.promise;
  await Promise.resolve();
  await assert.rejects(scope.disposeAsync(), error => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [failure]);
    return true;
  });
  assert.equal(calls, 1);
});

test("late async cleanup is observed and closed scopes cannot leak registrations", async () => {
  const ctx = host();
  const scope = createScopedContext(ctx, "late");
  const started = deferred();
  const stopped = deferred();
  const lateStarted = deferred();
  const lateStopped = deferred();
  const failure = new Error("late failure");
  let calls = 0;
  scope.scoped.onDispose(async () => {
    started.resolve();
    await stopped.promise;
    scope.scoped.onDispose(async () => {
      lateStarted.resolve();
      await lateStopped.promise;
      scope.scoped.define("leaked", () => true);
      scope.scoped.bus.on("ui:info", () => calls++);
      throw failure;
    });
  });
  const disposal = scope.disposeAsync();
  const rejection = assert.rejects(disposal, error => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [failure]);
    return true;
  });
  await started.promise;
  stopped.resolve();
  await lateStarted.promise;
  lateStopped.resolve();
  await rejection;
  ctx.bus.emit("ui:info", { message: "closed" });
  assert.equal(calls, 0);
  assert.deepEqual(ctx.list(), []);

  // Even registration after the stable disposal promise settles is released.
  const released = deferred();
  scope.scoped.onDispose(async () => {
    await Promise.resolve();
    calls++;
    released.resolve();
  });
  await released.promise;
  assert.equal(calls, 1);
  assert.equal(scope.disposeAsync(), disposal);
});

test("async scopes preserve the raw host context helper through nested scopes", async () => {
  const ctx = host();
  const first = createScopedContext(ctx, "first");
  const second = createScopedContext(first.scoped, "second");
  assert.equal(extensionHostContext(ctx), ctx);
  assert.equal(extensionHostContext(first.scoped), ctx);
  assert.equal(extensionHostContext(second.scoped), ctx);
  await second.disposeAsync();
  await first.disposeAsync();
  assert.equal(extensionHostContext(second.scoped), ctx);
});
