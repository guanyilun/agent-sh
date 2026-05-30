// Registers the Ink renderer: `ASHI_RENDERER=ink ashi -e ashi-ink`.

import type { ExtensionContext } from "agent-sh/types";
import { createInkRenderer } from "./ink-renderer.js";

export default function activate(ctx: ExtensionContext): void {
  ctx.define("ashi:renderer:ink", () => createInkRenderer());
}
