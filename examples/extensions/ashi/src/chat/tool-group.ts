// A run of same-kind tool calls, grown by tail-merge (the caller extends a group
// only while it matches `kind` and stays the chat's tail). Over `maxVisible` the
// oldest collapse into a summary line; toggleExpanded() reveals all.

import type { ContainerView, RenderNode, RenderNodes, TextView } from "../renderer.js";
import { theme } from "../theme.js";

export const GROUP_ICONS: Record<string, string> = { read: "◆", search: "⌕" };

interface GroupChild {
  name: string;
  detail: string;
  text: TextView;
  status?: { exitCode: number | null; summary?: string };
}

const SHORT_TOOL_NAMES: Record<string, string> = {
  read_file: "read",
  edit_file: "edit",
  write_file: "write",
};

function shortToolName(name: string): string {
  return SHORT_TOOL_NAMES[name] ?? name;
}

export class ToolGroup {
  readonly node: RenderNode;
  readonly kind: string;
  private headerText: TextView;
  private summaryText: TextView;
  private childContainer: ContainerView;
  private maxVisible: number;
  private allChildren: GroupChild[] = [];
  private callsById = new Map<string, GroupChild>();
  private expanded = false;

  constructor(private nodes: RenderNodes, kind: string, maxVisible: number = Infinity) {
    this.kind = kind;
    this.maxVisible = maxVisible;
    this.headerText = nodes.text({ paddingX: 1 });
    this.summaryText = nodes.text({ paddingX: 1 });
    this.childContainer = nodes.container();
    const container = nodes.container();
    container.addChild(nodes.spacer(1));
    container.addChild(this.headerText.node);
    container.addChild(this.summaryText.node);
    container.addChild(this.childContainer.node);
    this.node = container.node;
    this.repaintHeader();
  }

  addCall(toolCallId: string, name: string, detail: string): void {
    const text = this.nodes.text({ paddingX: 1 });
    const child: GroupChild = { name: shortToolName(name), detail: detail || "…", text };
    if (toolCallId) this.callsById.set(toolCallId, child);
    this.allChildren.push(child);
    this.repaint();
  }

  recordCompletion(toolCallId: string, exitCode: number | null, summary?: string): void {
    const child = this.callsById.get(toolCallId);
    if (!child) return;
    child.status = { exitCode, summary };
    this.repaint();
  }

  toggleExpanded(): void {
    this.expanded = !this.expanded;
    this.repaint();
  }

  /** First visible child index; collapsed and over-cap, one slot goes to the summary. */
  private visibleSliceStart(): number {
    if (this.expanded || !Number.isFinite(this.maxVisible)) return 0;
    if (this.allChildren.length <= this.maxVisible) return 0;
    return this.allChildren.length - (this.maxVisible - 1);
  }

  private repaint(): void {
    const start = this.visibleSliceStart();
    const evicted = this.allChildren.slice(0, start);
    const visible = this.allChildren.slice(start);

    if (evicted.length === 0) {
      this.summaryText.setText("");
    } else {
      const allOk = evicted.every(
        (c) => !c.status || c.status.exitCode === null || c.status.exitCode === 0,
      );
      const mark = allOk ? theme.fg("success", "✓") : theme.fg("error", "✗");
      const noun = evicted.length === 1 ? "earlier call" : "earlier calls";
      this.summaryText.setText(
        `${theme.fg("muted", "├")} ${theme.fg("muted", "⋯")} ${theme.fg("muted", `${evicted.length} ${noun}`)} ${mark}`,
      );
    }

    // Rebuild rather than diff the child container: group sizes are small.
    this.childContainer.clear();
    visible.forEach((child, idx) => {
      const isLast = idx === visible.length - 1;
      this.repaintChild(child, isLast);
      this.childContainer.addChild(child.text.node);
    });
  }

  private repaintChild(child: GroupChild, isLast: boolean): void {
    let tail: string;
    if (!child.status) {
      tail = ` ${theme.fg("muted", "…")}`;
    } else {
      const ok = child.status.exitCode === null || child.status.exitCode === 0;
      const mark = ok ? theme.fg("success", "✓") : theme.fg("error", "✗");
      const sum = child.status.summary ? ` ${theme.fg("muted", child.status.summary)}` : "";
      tail = ` ${mark}${sum}`;
    }
    const connector = isLast ? "└" : "├";
    const namePart = child.name !== this.kind
      ? `${theme.bold(theme.fg("toolTitle", child.name))} `
      : "";
    child.text.setText(`${theme.fg("muted", connector)} ${namePart}${theme.fg("muted", child.detail)} ${tail}`);
  }

  private repaintHeader(): void {
    const icon = GROUP_ICONS[this.kind] ?? "▶";
    this.headerText.setText(`${theme.fg("warning", icon)} ${theme.bold(theme.fg("toolTitle", this.kind))}`);
  }
}
