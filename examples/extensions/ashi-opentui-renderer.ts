// Example: a TUI renderer shipped as an extension. An extension registers
// `ashi:renderer:<name>` implementing ashi's Renderer contract; a user selects it
// with ASHI_RENDERER=<name>:
//
//   ASHI_RENDERER=opentui ashi -e ashi-opentui-renderer
//
// This is an OpenTUI SKELETON: it type-checks against the Renderer contract (the
// proof the contract is renderer-neutral), but the bodies are honest stubs that
// need `@opentui/core` to wire up.

import type { ExtensionContext } from "agent-sh/types";
import type { Renderer, RenderNode } from "@guanyilun/ashi/renderer";

function notImplemented(what: string): never {
  throw new Error(
    `opentui renderer: ${what} is not implemented yet. This is a skeleton that ` +
      `proves ashi's Renderer contract is renderer-neutral; wiring it up needs ` +
      `@opentui/core. Use ASHI_RENDERER=pi-tui (the default) for now.`,
  );
}

/** Visible width fallback (ANSI-stripped char count). Not wide-char-aware; a real
 *  OpenTUI renderer would defer to OpenTUI's own measurement. */
function measureWidth(text: string): number {
  return text.replace(/\x1b\[[0-9;]*m/g, "").length;
}

function createOpenTuiRenderer(): Renderer {
  return {
    text: () => notImplemented("text node"),
    markdown: () => notImplemented("markdown node"),
    image: (): RenderNode | null => null,
    container: () => notImplemented("container"),
    spacer: () => notImplemented("spacer"),
    capabilities: {
      images: false,
      markdownStreaming: false,
    },
    measureWidth,
    mountToolCall: () => notImplemented("mountToolCall"),
    mountToolResult: () => notImplemented("mountToolResult"),
    mount: () => notImplemented("app mount"),
  };
}

export default function activate(ctx: ExtensionContext): void {
  ctx.define("ashi:renderer:opentui", () => createOpenTuiRenderer());
}
