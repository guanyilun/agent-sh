// ui:* names are neutral by intent but declared HERE in ashi, not core, on purpose: a name
// graduates to core's BusEvents only when a second frontend outside ashi speaks it
// (see docs/ui-surface-protocol.md). ashi:* names carry TUI vocabulary and stay ashi-owned.
import type { RenderNode, RenderNodes } from "./renderer.js";
import type { StatusSegment } from "./status-footer.js";

declare module "agent-sh/event-bus" {
  interface BusEvents {
    "ui:notify": { message: string; level?: "info" | "warn" | "error" | "success" };
    "ui:status": { segments: StatusSegment[] };
    "ui:status:invalidate": Record<string, never>;
    "ashi:dock:above-input": { nodes: RenderNodes; views: RenderNode[] };
    "ashi:dock:invalidate": Record<string, never>;
    "ashi:ready": Record<string, never>;
  }
}
