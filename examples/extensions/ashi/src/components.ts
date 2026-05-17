import {
  Container,
  Markdown,
  type MarkdownTheme,
  Spacer,
  Text,
} from "@earendil-works/pi-tui";
import { markdownTheme, theme } from "./theme.js";
import type { ToolResultMode } from "./display-config.js";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

export class UserMessage extends Container {
  constructor(text: string, md: MarkdownTheme = markdownTheme()) {
    super();
    this.addChild(new Spacer(1));
    this.addChild(
      new Markdown(text, 1, 1, md, {
        bgColor: (t) => theme.bg("userMessageBg", t),
        color: (t) => theme.fg("userMessageText", t),
      }),
    );
  }
  override render(width: number): string[] {
    const lines = super.render(width);
    if (lines.length === 0) return lines;
    lines[0] = OSC133_ZONE_START + lines[0];
    lines[lines.length - 1] = lines[lines.length - 1] + OSC133_ZONE_END + OSC133_ZONE_FINAL;
    return lines;
  }
}

export class AssistantMessage extends Container {
  private md: Markdown;
  private buffer = "";
  constructor(mdTheme: MarkdownTheme = markdownTheme()) {
    super();
    this.md = new Markdown("", 1, 0, mdTheme);
    this.addChild(new Spacer(1));
    this.addChild(this.md);
  }
  appendText(t: string): void {
    this.buffer += t;
    this.md.setText(this.buffer);
  }
  appendCodeBlock(language: string, code: string): void {
    const prefix = this.buffer && !this.buffer.endsWith("\n") ? "\n" : "";
    this.buffer += `${prefix}\`\`\`${language}\n${code}\n\`\`\`\n`;
    this.md.setText(this.buffer);
  }
  finalize(): void {
    if (this.buffer === "") this.buffer = " ";
    this.md.setText(this.buffer);
  }
  hasContent(): boolean {
    return this.buffer.trim().length > 0;
  }
}

export class ThinkingBlock extends Container {
  private md: Markdown;
  private buffer = "";
  private hidden = false;
  private mdTheme: MarkdownTheme;
  constructor(mdTheme: MarkdownTheme = markdownTheme()) {
    super();
    this.mdTheme = mdTheme;
    this.md = new Markdown("", 1, 0, mdTheme, {
      color: (t) => theme.italic(theme.fg("thinkingText", t)),
    });
    this.addChild(new Spacer(1));
    this.addChild(this.md);
  }
  appendText(t: string): void {
    this.buffer += t;
    if (!this.hidden) this.md.setText(this.buffer);
  }
  finalize(): void {
    if (this.buffer === "") this.buffer = " ";
    if (!this.hidden) this.md.setText(this.buffer);
  }
  setHidden(hidden: boolean): void {
    if (hidden === this.hidden) return;
    this.hidden = hidden;
    this.clear();
    if (hidden) return;
    this.addChild(new Spacer(1));
    this.md = new Markdown(this.buffer, 1, 0, this.mdTheme, {
      color: (t) => theme.italic(theme.fg("thinkingText", t)),
    });
    this.addChild(this.md);
  }
}

export class ToolResultBody extends Container {
  private outputText: Text;
  private bodyText: Text;
  private outputBuffer = "";
  private diffRenderer: ((width: number) => string[]) | null = null;
  private lastDiffWidth = -1;
  private mode: ToolResultMode;
  private previewLines: number;
  private finalized = false;
  private expanded = false;
  private exitCode: number | null | undefined;

  constructor(mode: ToolResultMode, previewLines: number) {
    super();
    this.mode = mode;
    this.previewLines = previewLines;
    this.outputText = new Text("", 1, 0);
    this.bodyText = new Text("", 0, 0);
    this.addChild(this.outputText);
    this.addChild(this.bodyText);
  }

  appendChunk(chunk: string): void {
    this.outputBuffer += chunk;
    this.repaint();
  }

  setDiffRenderer(fn: (width: number) => string[]): void {
    this.diffRenderer = fn;
    this.lastDiffWidth = -1;
    this.repaint();
  }

  finalize(opts: { exitCode: number | null; summary?: string }): void {
    this.finalized = true;
    this.exitCode = opts.exitCode;
    this.repaint();
  }

  toggleExpanded(): void {
    this.expanded = !this.expanded;
    this.repaint();
  }

  override render(width: number): string[] {
    if (this.diffRenderer && width !== this.lastDiffWidth) {
      this.lastDiffWidth = width;
      const showDiff = this.expanded || this.mode === "preview";
      this.bodyText.setText(showDiff ? this.diffRenderer(width).join("\n") : "");
    }
    return super.render(width);
  }

  private repaint(): void {
    const hasDiff = this.diffRenderer !== null;
    const showDiff = hasDiff && (this.expanded || this.mode === "preview");
    if (showDiff && this.lastDiffWidth >= 0 && this.diffRenderer) {
      this.bodyText.setText(this.diffRenderer(this.lastDiffWidth).join("\n"));
    } else if (!showDiff) {
      this.bodyText.setText("");
    }

    // When a diff exists, the textual output ("Edited /path (+12 -3)") just
    // restates the call line — suppress its line-count hint to keep edits quiet.
    if (hasDiff && !this.expanded) {
      this.outputText.setText("");
      return;
    }
    if (!this.outputBuffer) {
      this.outputText.setText("");
      return;
    }
    if (this.expanded) {
      this.outputText.setText(theme.fg("toolOutput", this.outputBuffer));
      return;
    }
    if (this.mode === "hidden") {
      if (!this.finalized) { this.outputText.setText(""); return; }
      this.outputText.setText(lineCountHint(this.outputBuffer, this.exitCode));
      return;
    }
    if (this.mode === "summary") {
      if (!this.finalized) {
        // Brief tail while streaming; collapses to a line count on finalize.
        const tail = this.outputBuffer.split("\n").slice(-2).join("\n");
        this.outputText.setText(theme.fg("muted", tail));
        return;
      }
      this.outputText.setText(lineCountHint(this.outputBuffer, this.exitCode));
      return;
    }
    const lines = this.outputBuffer.split("\n");
    const trimmed = lines.slice(-this.previewLines).join("\n");
    const remaining = Math.max(0, lines.length - this.previewLines);
    const overflow = remaining > 0
      ? `\n${theme.fg("muted", `... (${remaining} more ${remaining === 1 ? "line" : "lines"})`)}`
      : "";
    this.outputText.setText(`${theme.fg("toolOutput", trimmed)}${overflow}`);
  }
}

function lineCountHint(buffer: string, exitCode: number | null | undefined): string {
  const lines = buffer.split("\n").filter((l) => l.length > 0);
  const label = lines.length === 1 ? "1 line" : `${lines.length} lines`;
  const ok = exitCode === null || exitCode === 0;
  const arrow = ok ? theme.fg("muted", "↳ ") : theme.fg("error", "↳ ");
  return `${arrow}${theme.fg("muted", label)}`;
}

export const GROUP_ICONS: Record<string, string> = { read: "◆", search: "⌕" };

interface GroupChild {
  name: string;
  detail: string;
  text: Text;
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

/** A batch of parallel same-kind tool calls. Renders one header, per-call
 *  child branch lines that each carry their own summary on completion, and
 *  a final aggregate. Mirrors ash's grouping (read_file/ls → "read";
 *  grep/glob → "search"). */
export class ToolGroup extends Container {
  private headerText: Text;
  private childContainer: Container;
  private aggregateText: Text;
  private kind: string;
  private total: number;
  private maxVisible: number;
  private visibleChildren = new Map<string, GroupChild>();
  private hiddenSummaries: string[] = [];
  private addedCount = 0;
  private renderedCount = 0;
  private completedCount = 0;
  private allOk = true;

  constructor(kind: string, total: number, maxVisible = 5) {
    super();
    this.kind = kind;
    this.total = total;
    this.maxVisible = maxVisible;
    this.headerText = new Text("", 1, 0);
    this.childContainer = new Container();
    this.aggregateText = new Text("", 1, 0);
    this.addChild(new Spacer(1));
    this.addChild(this.headerText);
    this.addChild(this.childContainer);
    this.addChild(this.aggregateText);
    this.repaintHeader();
  }

  addCall(toolCallId: string, name: string, detail: string): void {
    this.addedCount++;
    if (this.renderedCount < this.maxVisible && toolCallId) {
      const text = new Text("", 1, 0);
      const child: GroupChild = { name: shortToolName(name), detail: detail || "…", text };
      this.visibleChildren.set(toolCallId, child);
      this.childContainer.addChild(text);
      this.renderedCount++;
      this.repaintChild(child);
    }
  }

  recordCompletion(toolCallId: string, exitCode: number | null, summary?: string): void {
    this.completedCount++;
    if (exitCode !== null && exitCode !== 0) this.allOk = false;
    const child = this.visibleChildren.get(toolCallId);
    if (child) {
      child.status = { exitCode, summary };
      this.repaintChild(child);
    } else if (summary) {
      this.hiddenSummaries.push(summary);
    }
    if (this.completedCount >= this.total) this.finalize();
  }

  finalize(): void {
    const collapsed = this.addedCount - this.renderedCount;
    // No overflow ⇒ no aggregate; close the tree by promoting the last
    // visible child's ├ to a └.
    if (collapsed === 0) {
      this.aggregateText.setText("");
      const last = [...this.visibleChildren.values()].pop();
      if (last) this.repaintChild(last, true);
      return;
    }
    const mark = this.allOk ? theme.fg("success", "✓") : theme.fg("error", "✗");
    const more = theme.fg("muted", `+${collapsed} more`);
    const sumText = this.hiddenSummaries.length > 0
      ? ` ${theme.fg("muted", this.hiddenSummaries.join(", "))}`
      : "";
    this.aggregateText.setText(`${theme.fg("muted", "└")} ${more} ${mark}${sumText}`);
  }

  isComplete(): boolean { return this.completedCount >= this.total; }

  private repaintChild(child: GroupChild, isLast = false): void {
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
    // Tool name omitted when it duplicates the kind header (e.g. read_file
    // children under "◆ read").
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

export class ErrorLine extends Container {
  constructor(message: string) {
    super();
    this.addChild(new Text(`${theme.fg("error", "✗")} ${theme.fg("error", message)}`, 1, 0));
  }
}

export class InfoLine extends Container {
  constructor(message: string) {
    super();
    this.addChild(new Text(theme.fg("muted", message), 1, 0));
  }
}
