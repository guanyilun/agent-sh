// Example: a TUI renderer shipped as an extension.
//
// Renderers in ashi are extensions. An extension registers `ashi:renderer:<name>`
// returning a value that implements ashi's Renderer contract
// (`@guanyilun/ashi/renderer`); a user selects it with ASHI_RENDERER=<name>.
// Because the substrate (schema, theme, chat controllers, frontend) depends only
// on that interface, a custom renderer needs zero changes to ashi itself — this
// is how you build a different TUI frontend (OpenTUI, Ink, a remote/web bridge…).
//
//   ASHI_RENDERER=opentui ashi -e ashi-opentui-renderer
//
// This particular renderer is an OpenTUI SKELETON: it type-checks against the
// Renderer contract (the proof the contract is renderer-neutral), but the bodies
// are honest stubs. Wiring them needs `@opentui/core` and a TTY. Each member is
// annotated with the OpenTUI concept that would back it:
//
//   text / markdown        -> an OpenTUI TextRenderable; markdown projects styled
//                             lines (renderBody from the schema is renderer-agnostic)
//   container              -> a GroupRenderable / BoxRenderable
//   spacer                 -> a fixed-height empty renderable
//   image                  -> the terminal graphics protocol, if supported
//   mount()                -> OpenTUI's CLI renderer as the root + the chat stack
//                             (scrollback / footer / queue / input / status),
//                             keyboard events feeding onKey, and input + select-list
//                             widgets for the editor and pickers

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
    image: (): RenderNode | null => null, // honest: no image support yet
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
