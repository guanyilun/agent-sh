import type { RenderNode, RenderNodes } from "../renderer.js";
import { theme, type ThemeColor } from "../theme.js";

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

export type NoticeLevel = "info" | "warn" | "error" | "success";

const NOTICE: Record<NoticeLevel, { color: ThemeColor; prefix: string }> = {
  info: { color: "muted", prefix: "" },
  success: { color: "success", prefix: "✓ " },
  warn: { color: "warning", prefix: "! " },
  error: { color: "error", prefix: "✗ " },
};

export class NoticeLine {
  readonly node: RenderNode;
  constructor(nodes: RenderNodes, message: string, level: NoticeLevel = "info") {
    const { color, prefix } = NOTICE[level];
    const t = nodes.text({ paddingX: 1 });
    t.setText(`${theme.fg(color, prefix)}${theme.fg(color, message)}`);
    this.node = t.node;
  }
}
