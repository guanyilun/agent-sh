// Registers the Ink renderer so `ASHI_RENDERER=ink ashi -e ashi-ink` runs ashi's
// TUI on Ink (React) instead of pi-tui — a renderer shipped purely as an extension.

import type { ExtensionContext } from "agent-sh/types";
import { createInkRenderer } from "./ink-renderer.js";

export default function activate(ctx: ExtensionContext): void {
  ctx.define("ashi:renderer:ink", () => createInkRenderer());
}
