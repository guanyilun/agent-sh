import type { ExtensionContext } from "agent-sh/types";
import type { RenderNode, RenderNodes } from "./renderer.js";
import type { StatusSegment } from "./status-footer.js";
import type { SelectOpts, ConfirmOpts } from "./dialogs.js";
import type { InputOpts } from "./input-prompt.js";

export type { SelectChoice, SelectOpts, ConfirmOpts } from "./dialogs.js";
export type { InputOpts } from "./input-prompt.js";
export type { StatusSegment } from "./status-footer.js";

export type NoticeLevel = "info" | "warn" | "error" | "success";

export interface Contribution {
  /** Re-pull this surface (call after the content it depends on changes). */
  refresh(): void;
  remove(): void;
}

/**
 * Typed sugar over ashi's UI protocol. Wraps the bus events and named handlers so call
 * sites read like a UI object, with real types and no magic strings — without a `ui` field
 * on the kernel context. Request/response surfaces degrade when no frontend answers them
 * (select/input → undefined, confirm → false, getEditorText → "").
 */
export interface Ui {
  notify(message: string, level?: NoticeLevel): void;
  select(opts: SelectOpts): Promise<string | undefined>;
  confirm(opts: ConfirmOpts): Promise<boolean>;
  input(opts?: InputOpts): Promise<string | undefined>;
  getEditorText(): string;
  setEditorText(text: string): void;
  /** Contribute a status-bar segment. `get` runs on each repaint; return null to show nothing. */
  status(get: () => StatusSegment | null): Contribution;
  /** Contribute a pinned widget above the input, built from the renderer's node factory. */
  dock(build: (nodes: RenderNodes) => RenderNode | null): Contribution;
}

export function createUi(ctx: ExtensionContext): Ui {
  const has = (name: string): boolean => ctx.list().includes(name);

  return {
    notify(message, level) {
      ctx.bus.emit("ui:notify", { message, level });
    },
    select(opts) {
      if (!has("ui:select")) return Promise.resolve(undefined);
      return ctx.call("ui:select", opts) as Promise<string | undefined>;
    },
    confirm(opts) {
      if (!has("ui:confirm")) return Promise.resolve(false);
      return ctx.call("ui:confirm", opts) as Promise<boolean>;
    },
    input(opts = {}) {
      if (!has("ui:input")) return Promise.resolve(undefined);
      return ctx.call("ui:input", opts) as Promise<string | undefined>;
    },
    getEditorText() {
      return has("ui:editor:get-text") ? (ctx.call("ui:editor:get-text") as string) : "";
    },
    setEditorText(text) {
      if (has("ui:editor:set-text")) ctx.call("ui:editor:set-text", text);
    },
    status(get) {
      const contribute = (p: { segments: StatusSegment[] }): { segments: StatusSegment[] } => {
        const seg = get();
        return seg ? { segments: [...p.segments, seg] } : p;
      };
      ctx.bus.onPipe("ui:status", contribute);
      return {
        refresh: () => ctx.bus.emit("ui:status:invalidate", {}),
        remove: () => ctx.bus.offPipe("ui:status", contribute),
      };
    },
    dock(build) {
      const contribute = (
        p: { nodes: RenderNodes; views: RenderNode[] },
      ): { nodes: RenderNodes; views: RenderNode[] } => {
        const view = build(p.nodes);
        return view ? { ...p, views: [...p.views, view] } : p;
      };
      ctx.bus.onPipe("ashi:dock:above-input", contribute);
      return {
        refresh: () => ctx.bus.emit("ashi:dock:invalidate", {}),
        remove: () => ctx.bus.offPipe("ashi:dock:above-input", contribute),
      };
    },
  };
}
