import test from "node:test";
import assert from "node:assert/strict";
import { EventBus } from "agent-sh/event-bus";
import { createNodes, footerContainer } from "../src/renderers/pi-tui/nodes.js";
import { createDock } from "../src/docks.js";
import type { App, Renderer } from "../src/renderer.js";

// Uses the REAL pi-tui renderer (not fakes), unlike ui-dock.test.ts: verifies actual paint
// and the footer-spacing interaction, which fakes can't catch.

const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");
const render = (node: unknown, width = 80): string[] =>
  (node as { render(width: number): string[] }).render(width).map(strip);

function harness(hasContentAbove: () => boolean) {
  const nodes = createNodes();
  const footer = footerContainer(hasContentAbove);
  const app = { footerSlot: footer, requestRender() {} } as unknown as App;
  return { app, renderer: nodes as unknown as Renderer, footer };
}

test("real render: empty dock keeps the footer's blank-line spacing above the input", () => {
  const bus = new EventBus();
  const h = harness(() => true);
  createDock(h.app, h.renderer, bus);
  assert.deepEqual(render(h.footer.node), [""], "spacer line preserved when the dock is empty");
});

test("real render: no content above + empty dock → footer renders nothing", () => {
  const bus = new EventBus();
  const h = harness(() => false);
  createDock(h.app, h.renderer, bus);
  assert.deepEqual(render(h.footer.node), [], "no spacer before any conversation starts");
});

test("real render: a dock contributor's text actually paints in the footer", () => {
  const bus = new EventBus();
  bus.onPipe("ashi:dock:above-input", (p) => {
    const t = p.nodes.text({ paddingX: 1 });
    t.setText("📌 pinned");
    return { ...p, views: [...p.views, t.node] };
  });
  const h = harness(() => true);
  createDock(h.app, h.renderer, bus);
  const lines = render(h.footer.node);
  assert.ok(lines.some((l) => l.includes("📌 pinned")), `painted: ${JSON.stringify(lines)}`);
});
