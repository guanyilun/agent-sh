import test from "node:test";
import assert from "node:assert/strict";
import { EventBus } from "agent-sh/event-bus";
import { createUi } from "../src/ui.js";
import type { ExtensionContext } from "agent-sh/types";

function fakeCtx(handlers: Record<string, (...args: unknown[]) => unknown> = {}) {
  const bus = new EventBus();
  const ctx = {
    bus,
    list: () => Object.keys(handlers),
    call: (name: string, ...args: unknown[]) => handlers[name]?.(...args),
  } as unknown as ExtensionContext;
  return { ctx, bus };
}

test("notify emits ui:notify with the level", () => {
  const { ctx, bus } = fakeCtx();
  let got: unknown = null;
  bus.on("ui:notify", (e) => { got = e; });
  createUi(ctx).notify("hi", "success");
  assert.deepEqual(got, { message: "hi", level: "success" });
});

test("select forwards to ctx.call and returns its value (typed string | undefined)", async () => {
  const { ctx } = fakeCtx({ "ui:select": () => Promise.resolve("apple") });
  const chosen: string | undefined = await createUi(ctx).select({ items: [{ value: "apple", label: "A" }] });
  assert.equal(chosen, "apple");
});

test("select degrades to undefined when no frontend answers", async () => {
  const { ctx } = fakeCtx(); // ui:select not registered
  assert.equal(await createUi(ctx).select({ items: [] }), undefined);
});

test("confirm degrades to false when no frontend answers", async () => {
  const { ctx } = fakeCtx();
  const ok: boolean = await createUi(ctx).confirm({ title: "?" });
  assert.equal(ok, false);
});

test("getEditorText degrades to empty string", () => {
  const { ctx } = fakeCtx();
  assert.equal(createUi(ctx).getEditorText(), "");
});

test("status contributes a segment via the ui:status pipe", () => {
  const { ctx, bus } = fakeCtx();
  createUi(ctx).status(() => ({ id: "x", text: "seg", color: "accent" }));
  const { segments } = bus.emitPipe("ui:status", { segments: [] });
  assert.equal(segments.length, 1);
  assert.equal(segments[0]?.text, "seg");
});

test("status get returning null contributes nothing", () => {
  const { ctx, bus } = fakeCtx();
  createUi(ctx).status(() => null);
  assert.equal(bus.emitPipe("ui:status", { segments: [] }).segments.length, 0);
});

test("status: refresh emits invalidate, remove unsubscribes", () => {
  const { ctx, bus } = fakeCtx();
  let invalidated = 0;
  bus.on("ui:status:invalidate", () => { invalidated++; });
  const h = createUi(ctx).status(() => ({ id: "x", text: "seg" }));
  h.refresh();
  assert.equal(invalidated, 1);
  h.remove();
  assert.equal(bus.emitPipe("ui:status", { segments: [] }).segments.length, 0);
});

test("dock builds a view from the node factory", () => {
  const { ctx, bus } = fakeCtx();
  createUi(ctx).dock((nodes) => nodes.text().node);
  const nodes = { text: () => ({ node: { t: "text" }, setText() {} }) } as never;
  const { views } = bus.emitPipe("ashi:dock:above-input", { nodes, views: [] });
  assert.equal(views.length, 1);
});
