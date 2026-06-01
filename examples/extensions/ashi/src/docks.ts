import type { EventBus } from "agent-sh/event-bus";
import type { App, Renderer } from "./renderer.js";

export interface Dock {
  refresh(): void;
}

export function createDock(app: App, renderer: Renderer, bus: EventBus): Dock {
  const container = renderer.container();
  let mounted = false;

  const refresh = (): void => {
    container.clear();
    const { views } = bus.emitPipe("ashi:dock:above-input", { nodes: renderer, views: [] });
    for (const view of views) container.addChild(view);
    // Mount only when non-empty: an always-present footer child (even empty) defeats the
    // footer slot's blank-line spacing above the input.
    if (views.length > 0 && !mounted) {
      app.footerSlot.addChild(container.node);
      mounted = true;
    } else if (views.length === 0 && mounted) {
      app.footerSlot.removeChild(container.node);
      mounted = false;
    }
    app.requestRender();
  };

  bus.on("ashi:dock:invalidate", refresh);
  refresh();
  return { refresh };
}
