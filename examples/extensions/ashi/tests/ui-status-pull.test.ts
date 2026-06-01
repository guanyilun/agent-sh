import test from "node:test";
import assert from "node:assert/strict";
import { EventBus } from "agent-sh/event-bus";
import { StatusFooter, type StatusSegment } from "../src/status-footer.js";
import type { TextView } from "../src/renderer.js";

const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

function fakeView(): { view: TextView; line: (w?: number) => string } {
  let fn: ((width: number) => string[]) | null = null;
  const view = {
    setRenderFn(f: ((width: number) => string[]) | null) { fn = f; },
  } as unknown as TextView;
  return { view, line: (w = 80) => strip((fn?.(w) ?? [""])[0] ?? "") };
}

const pullFrom = (bus: EventBus) => (): StatusSegment[] =>
  bus.emitPipe("ui:status", { segments: [] as StatusSegment[] }).segments;

test("ui:status pull pipe: an extension's segment lands in the footer", () => {
  const bus = new EventBus();
  bus.onPipe("ui:status", (p) => ({ segments: [...p.segments, { id: "demo", text: "★ demo" }] }));

  const { view, line } = fakeView();
  const footer = new StatusFooter(view, (s) => s.length, pullFrom(bus));
  footer.update({ model: "opus" });

  const out = line();
  assert.ok(out.includes("opus"), `built-in segment present: ${out}`);
  assert.ok(out.includes("★ demo"), `extension segment present: ${out}`);
});

test("ui:status: no contributors → footer is unchanged", () => {
  const bus = new EventBus();
  const { view, line } = fakeView();
  const footer = new StatusFooter(view, (s) => s.length, pullFrom(bus));
  footer.update({ model: "opus" });
  assert.equal(line().includes("|"), false, "no extra separators when nothing contributes");
  assert.ok(line().includes("opus"));
});

test("ui:status:invalidate re-pulls the contributor's current value", () => {
  const bus = new EventBus();
  let label = "v1";
  bus.onPipe("ui:status", (p) => ({ segments: [...p.segments, { id: "demo", text: label }] }));

  const { view, line } = fakeView();
  const footer = new StatusFooter(view, (s) => s.length, pullFrom(bus));
  footer.update({ model: "opus" });
  assert.ok(line().includes("v1"));

  label = "v2";
  footer.refresh();
  assert.ok(line().includes("v2"), `re-pulled after invalidate: ${line()}`);
});
