import {
  type Component,
  Container,
  getImageDimensions,
  Image,
  Markdown,
  type MarkdownTheme,
  Spacer,
  Text,
} from "@earendil-works/pi-tui";
import { theme } from "./theme.js";
import { markdownTheme } from "./renderers/pi-tui/theme-adapters.js";

export function pngToImageComponent(data: Buffer): Image | null {
  const base64 = data.toString("base64");
  const dims = getImageDimensions(base64, "image/png");
  if (!dims) return null;
  return new Image(
    base64,
    "image/png",
    { fallbackColor: (t) => theme.fg("muted", t) },
    { maxWidthCells: 60, maxHeightCells: 20 },
    dims,
  );
}

export type EquationRenderer = (latexSrc: string) => Component | null;

type LatexSegment =
  | { type: "text"; value: string }
  | { type: "latex"; value: string; raw: string };

/** Inline-$ close index, or -1. Pandoc guards keep "$5 and $10" as text. */
function findInlineClose(text: string, from: number): number {
  const openChar = text[from];
  if (openChar === undefined || openChar === "$" || /\s/.test(openChar)) return -1;
  for (let j = from; j < text.length; j++) {
    const c = text[j];
    if (c === "\n") return -1;
    if (c === "\\") { j++; continue; }
    if (c === "$") {
      const prev = text[j - 1];
      const next = text[j + 1];
      const closes = prev !== undefined && !/\s/.test(prev)
        && !(next !== undefined && /[0-9]/.test(next));
      return closes ? j : -1;
    }
  }
  return -1;
}

export function segmentLatex(text: string): LatexSegment[] {
  const segments: LatexSegment[] = [];
  let textStart = 0;
  let i = 0;
  const flushText = (end: number): void => {
    if (end > textStart) segments.push({ type: "text", value: text.slice(textStart, end) });
  };
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\" && text[i + 1] === "$") { i += 2; continue; }
    if (ch !== "$") { i += 1; continue; }
    if (text[i + 1] === "$") {
      const close = text.indexOf("$$", i + 2);
      if (close !== -1) {
        flushText(i);
        segments.push({ type: "latex", value: text.slice(i + 2, close).trim(), raw: text.slice(i, close + 2) });
        i = close + 2; textStart = i; continue;
      }
      i += 2; continue;
    }
    const close = findInlineClose(text, i + 1);
    if (close !== -1) {
      flushText(i);
      segments.push({ type: "latex", value: text.slice(i + 1, close).trim(), raw: text.slice(i, close + 1) });
      i = close + 1; textStart = i; continue;
    }
    i += 1;
  }
  flushText(text.length);
  return segments;
}

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
  private mdTheme: MarkdownTheme;
  private renderEquation?: EquationRenderer;
  constructor(mdTheme: MarkdownTheme = markdownTheme(), renderEquation?: EquationRenderer) {
    super();
    this.mdTheme = mdTheme;
    this.renderEquation = renderEquation;
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
    if (this.renderEquation && this.buffer.includes("$")) {
      this.rebuildWithEquations();
    } else {
      this.md.setText(this.buffer);
    }
  }
  private rebuildWithEquations(): void {
    const segments = segmentLatex(this.buffer);
    if (!segments.some((s) => s.type === "latex")) {
      this.md.setText(this.buffer);
      return;
    }
    this.clear();
    this.addChild(new Spacer(1));
    for (const seg of segments) {
      if (seg.type === "text") {
        if (seg.value.trim()) this.addChild(new Markdown(seg.value, 1, 0, this.mdTheme));
      } else {
        this.addChild(this.renderEquation!(seg.value) ?? new Markdown(seg.raw, 1, 0, this.mdTheme));
      }
    }
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

/** An open-ended run of same-kind tool calls. Grows by tail-merge: the caller
 *  extends an existing group when its `kind` matches the next call and the
 *  group is still the chat's tail. Trailing child renders with └, others ├.
 *
 *  When `maxVisible` is finite and exceeded, the oldest children collapse to
 *  a summary line ("⋯ N earlier ✓") and the last (maxVisible − 1) stay
 *  visible. `toggleExpanded()` reveals all; `maxVisible = Infinity` disables
 *  eviction. */
export class ToolGroup extends Container {
  private headerText: Text;
  private summaryText: Text;
  private childContainer: Container;
  readonly kind: string;
  private maxVisible: number;
  private allChildren: GroupChild[] = [];
  private callsById = new Map<string, GroupChild>();
  private expanded = false;

  constructor(kind: string, maxVisible: number = Infinity) {
    super();
    this.kind = kind;
    this.maxVisible = maxVisible;
    this.headerText = new Text("", 1, 0);
    this.summaryText = new Text("", 1, 0);
    this.childContainer = new Container();
    this.addChild(new Spacer(1));
    this.addChild(this.headerText);
    this.addChild(this.summaryText);
    this.addChild(this.childContainer);
    this.repaintHeader();
  }

  addCall(toolCallId: string, name: string, detail: string): void {
    const text = new Text("", 1, 0);
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

  /** How many children at the tail are visible right now. When collapsed and
   *  over the cap, this is maxVisible − 1 (one line goes to the summary). */
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

    // Reconcile childContainer to exactly the `visible` slice, in order. We
    // rebuild rather than diff because group sizes are small.
    this.childContainer.clear();
    visible.forEach((child, idx) => {
      const isLast = idx === visible.length - 1;
      this.repaintChild(child, isLast);
      this.childContainer.addChild(child.text);
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
