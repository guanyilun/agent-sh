import type { Renderer, RenderNode, ToolGroupChild, ToolGroupModel, ToolGroupView } from "../renderer.js";

export const GROUP_ICONS: Record<string, string> = { read: "◆", search: "⌕" };

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
  private view: ToolGroupView;
  private maxVisible: number;
  private allChildren: ToolGroupChild[] = [];
  private callsById = new Map<string, ToolGroupChild>();
  private expanded = false;

  constructor(renderer: Renderer, kind: string, maxVisible: number = Infinity) {
    this.kind = kind;
    this.maxVisible = maxVisible;
    this.view = renderer.mountToolGroup!();
    this.node = this.view.node;
    this.repaint();
  }

  addCall(toolCallId: string, name: string, detail: string): void {
    const child: ToolGroupChild = { name: shortToolName(name), detail: detail || "…" };
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

  // When collapsed and over-cap, one visible slot is reserved for the summary.
  private visibleSliceStart(): number {
    if (this.expanded || !Number.isFinite(this.maxVisible)) return 0;
    if (this.allChildren.length <= this.maxVisible) return 0;
    return this.allChildren.length - (this.maxVisible - 1);
  }

  private repaint(): void {
    const start = this.visibleSliceStart();
    const evicted = this.allChildren.slice(0, start);
    const hidden = evicted.length === 0
      ? null
      : {
          count: evicted.length,
          ok: evicted.every((c) => !c.status || c.status.exitCode === null || c.status.exitCode === 0),
        };
    const model: ToolGroupModel = {
      kind: this.kind,
      icon: GROUP_ICONS[this.kind] ?? "▶",
      children: this.allChildren.slice(start),
      hidden,
      expanded: this.expanded,
    };
    this.view.update(model);
  }
}
