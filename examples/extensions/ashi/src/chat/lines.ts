// Single-line chat entries (info / error). Renderer-agnostic controllers over a
// text node; the host mounts `.node` into the scrollback.

import type { RenderNode, RenderNodes } from "../renderer.js";
import { theme } from "../theme.js";

export class InfoLine {
  readonly node: RenderNode;
  constructor(nodes: RenderNodes, message: string) {
    const t = nodes.text({ paddingX: 1 });
    t.setText(theme.fg("muted", message));
    this.node = t.node;
  }
}

export class ErrorLine {
  readonly node: RenderNode;
  constructor(nodes: RenderNodes, message: string) {
    const t = nodes.text({ paddingX: 1 });
    t.setText(`${theme.fg("error", "✗")} ${theme.fg("error", message)}`);
    this.node = t.node;
  }
}
