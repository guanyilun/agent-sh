import test from "node:test";
import assert from "node:assert/strict";

import { EventBus, type BusFault } from "../../src/core/event-bus.js";

test("a throwing on-listener does not stop a sibling or throw out of emit", () => {
  const bus = new EventBus();
  const seen: string[] = [];

  bus.on("ui:info", () => { throw new Error("boom"); });
  bus.on("ui:info", (p) => { seen.push(p.message); });

  assert.doesNotThrow(() => bus.emit("ui:info", { message: "hello" }));
  assert.deepEqual(seen, ["hello"]);
});

test("listener faults are surfaced to the installed reporter with phase/event", () => {
  const bus = new EventBus();
  const faults: BusFault[] = [];
  bus.setErrorReporter((f) => faults.push(f));

  const boom = new Error("boom");
  bus.on("ui:info", () => { throw boom; });
  bus.emit("ui:info", { message: "x" });

  assert.equal(faults.length, 1);
  assert.equal(faults[0].phase, "on");
  assert.equal(faults[0].event, "ui:info");
  assert.equal(faults[0].err, boom);
});

test("a broken reporter cannot break dispatch", () => {
  const bus = new EventBus();
  const seen: string[] = [];
  bus.setErrorReporter(() => { throw new Error("reporter is broken too"); });

  bus.on("ui:info", () => { throw new Error("boom"); });
  bus.on("ui:info", (p) => { seen.push(p.message); });

  assert.doesNotThrow(() => bus.emit("ui:info", { message: "hi" }));
  assert.deepEqual(seen, ["hi"]);
});

test("a rejecting async-pipe transform is isolated and the chain continues", async () => {
  const bus = new EventBus();
  const faults: BusFault[] = [];
  bus.setErrorReporter((f) => faults.push(f));

  bus.onPipeAsync("config:switch-backend", () => { throw new Error("nope"); });
  bus.onPipeAsync("config:switch-backend", async (p) => ({ name: p.name + "!" }));

  const out = await bus.emitPipeAsync("config:switch-backend", { name: "ash" });

  assert.equal(out.name, "ash!");
  assert.equal(faults.length, 1);
  assert.equal(faults[0].phase, "pipe-async");
});

test("a throwing sync-pipe transform is a no-op, keeping the last good payload", () => {
  const bus = new EventBus();
  const faults: BusFault[] = [];
  bus.setErrorReporter((f) => faults.push(f));

  bus.onPipe("config:switch-backend", (p) => ({ name: p.name + "-a" }));
  bus.onPipe("config:switch-backend", () => { throw new Error("nope"); });
  bus.onPipe("config:switch-backend", (p) => ({ name: p.name + "-c" }));

  const out = bus.emitPipe("config:switch-backend", { name: "x" });

  assert.equal(out.name, "x-a-c");
  assert.equal(faults.length, 1);
  assert.equal(faults[0].phase, "pipe");
});

test("on/off/emit deliver in subscription order and off unsubscribes", () => {
  const bus = new EventBus();
  const order: number[] = [];
  const second = () => order.push(2);

  bus.on("ui:info", () => order.push(1));
  bus.on("ui:info", second);
  bus.on("ui:info", () => order.push(3));

  bus.emit("ui:info", { message: "" });
  assert.deepEqual(order, [1, 2, 3]);

  bus.off("ui:info", second);
  order.length = 0;
  bus.emit("ui:info", { message: "" });
  assert.deepEqual(order, [1, 3]);
});

test("a listener that subscribes mid-dispatch does not receive the in-flight event", () => {
  const bus = new EventBus();
  let lateCalls = 0;

  bus.on("ui:info", () => {
    bus.on("ui:info", () => { lateCalls++; });
  });

  bus.emit("ui:info", { message: "" });
  assert.equal(lateCalls, 0);

  bus.emit("ui:info", { message: "" });
  assert.equal(lateCalls, 1);
});
