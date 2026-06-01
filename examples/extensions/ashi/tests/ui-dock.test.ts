import test from "node:test";
import assert from "node:assert/strict";
import { EventBus } from "agent-sh/event-bus";
import { createDock } from "../src/docks.js";
import type { App, ContainerView, RenderNode, Renderer } from "../src/renderer.js";

const node = (tag: string): RenderNode => ({ tag }) as unknown as RenderNode;

function fakeContainer(): ContainerView & { children: RenderNode[] } {
  const children: RenderNode[] = [];
  return {
    node: node("container"),
    children,
    addChild(c) { children.push(c); },
    removeChild(c) { const i = children.indexOf(c); if (i >= 0) children.splice(i, 1); },
    clear() { children.length = 0; },
  };
}

function harness() {
  const dock = fakeContainer();
  const footer = fakeContainer();
  const renderer = {
    container: () => dock,
    text: () => ({ node: node("text"), setText() {}, setLines() {}, setRenderFn() {} }),
  } as unknown as Renderer;
  const app = { footerSlot: footer, requestRender() {} } as unknown as App;
  return { app, renderer, dockChildren: () => dock.children, footerChildren: () => footer.children };
}

test("ashi:dock pull pipe: a contributor's view lands in the dock and mounts", () => {
  const bus = new EventBus();
  bus.onPipe("ashi:dock:above-input", (p) => ({ ...p, views: [...p.views, p.nodes.text().node] }));

  const h = harness();
  createDock(h.app, h.renderer, bus);

  assert.equal(h.dockChildren().length, 1, "one contributed view");
  assert.equal(h.footerChildren().length, 1, "dock mounted into footerSlot when non-empty");
});

test("ashi:dock: no contributors → dock not mounted (preserves footer spacing)", () => {
  const bus = new EventBus();
  const h = harness();
  createDock(h.app, h.renderer, bus);
  assert.equal(h.dockChildren().length, 0);
  assert.equal(h.footerChildren().length, 0, "empty dock must not occupy footerSlot");
});

test("ashi:dock:invalidate mounts/unmounts as contributions appear and vanish", () => {
  const bus = new EventBus();
  let count = 0;
  bus.onPipe("ashi:dock:above-input", (p) => {
    const views = [...p.views];
    for (let i = 0; i < count; i++) views.push(p.nodes.text().node);
    return { ...p, views };
  });

  const h = harness();
  createDock(h.app, h.renderer, bus);
  assert.equal(h.footerChildren().length, 0, "not mounted while empty");

  count = 2;
  bus.emit("ashi:dock:invalidate", {});
  assert.equal(h.dockChildren().length, 2, "re-pulled after invalidate");
  assert.equal(h.footerChildren().length, 1, "mounted once non-empty");

  count = 0;
  bus.emit("ashi:dock:invalidate", {});
  assert.equal(h.dockChildren().length, 0);
  assert.equal(h.footerChildren().length, 0, "unmounted when contributions vanish");
});
