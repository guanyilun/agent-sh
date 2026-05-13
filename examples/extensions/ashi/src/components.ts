import {
  Container,
  Markdown,
  type MarkdownTheme,
  Spacer,
  Text,
} from "@earendil-works/pi-tui";
import { iconFor, markdownTheme, theme } from "./theme.js";
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
  private placeholder: Text;
  private buffer = "";
  private hidden = false;
  private mdTheme: MarkdownTheme;
  constructor(mdTheme: MarkdownTheme = markdownTheme()) {
    super();
    this.mdTheme = mdTheme;
    this.md = new Markdown("", 1, 0, mdTheme, {
      color: (t) => theme.italic(theme.fg("thinkingText", t)),
    });
    this.placeholder = new Text(theme.italic(theme.fg("thinkingText", "Thinking…")), 1, 0);
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
    this.addChild(new Spacer(1));
    if (hidden) {
      this.addChild(this.placeholder);
    } else {
      this.md = new Markdown(this.buffer, 1, 0, this.mdTheme, {
        color: (t) => theme.italic(theme.fg("thinkingText", t)),
      });
      this.addChild(this.md);
    }
  }
}

export class ToolCallLine extends Container {
  private line: Text;
  private title: string;
  private detail?: string;
  private kind?: string;
  private startedAt: number;
  private exitCode: number | null | undefined;
  private elapsedMs?: number;
  private summary?: string;

  constructor(title: string, kind?: string, detail?: string) {
    super();
    this.title = title;
    this.kind = kind;
    this.detail = detail;
    this.startedAt = Date.now();
    this.line = new Text("", 1, 0);
    this.addChild(new Spacer(1));
    this.addChild(this.line);
    this.repaint();
  }

  setStatus(opts: { exitCode: number | null; elapsedMs: number; summary?: string }): void {
    this.exitCode = opts.exitCode;
    this.elapsedMs = opts.elapsedMs;
    this.summary = opts.summary;
    this.repaint();
  }

  private repaint(): void {
    const icon = iconFor(this.kind);
    const head = theme.bold(theme.fg("toolTitle", `${icon} ${this.title}`));
    const detail = this.detail ? ` ${theme.fg("muted", this.detail)}` : "";
    let tail: string;
    if (this.exitCode !== undefined) {
      const ok = this.exitCode === null || this.exitCode === 0;
      const mark = ok ? theme.fg("success", "✓") : theme.fg("error", "✗");
      const elapsed = this.elapsedMs !== undefined ? ` ${theme.fg("muted", fmtElapsed(this.elapsedMs))}` : "";
      const sum = this.summary ? ` ${theme.fg("muted", this.summary)}` : "";
      tail = `  ${mark}${elapsed}${sum}`;
    } else {
      tail = `  ${theme.fg("muted", "…")}`;
    }
    this.line.setText(`${head}${detail}${tail}`);
  }
}

export class ToolResultBody extends Container {
  private outputText: Text;
  private bodyText: Text;
  private outputBuffer = "";
  private mode: ToolResultMode;
  private previewLines: number;
  private finalized = false;
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

  setDiff(lines: string[]): void {
    this.bodyText.setText(lines.join("\n"));
  }

  finalize(opts: { exitCode: number | null; summary?: string }): void {
    this.finalized = true;
    this.exitCode = opts.exitCode;
    this.repaint();
  }

  private repaint(): void {
    if (this.mode === "hidden") {
      this.outputText.setText("");
      return;
    }
    if (!this.outputBuffer) {
      this.outputText.setText("");
      return;
    }
    if (this.mode === "summary") {
      if (!this.finalized) {
        // While streaming, summary mode shows a brief tail; on finalize, switch to a line count.
        const tail = this.outputBuffer.split("\n").slice(-2).join("\n");
        this.outputText.setText(theme.fg("muted", tail));
        return;
      }
      const lines = this.outputBuffer.split("\n").filter((l) => l.length > 0);
      const label = lines.length === 1 ? "1 line" : `${lines.length} lines`;
      const ok = this.exitCode === null || this.exitCode === 0;
      const prefix = ok ? theme.fg("muted", "↳ ") : theme.fg("error", "↳ ");
      this.outputText.setText(`${prefix}${theme.fg("muted", label)}`);
      return;
    }
    const trimmed = this.outputBuffer.split("\n").slice(-this.previewLines).join("\n");
    this.outputText.setText(theme.fg("toolOutput", trimmed));
  }
}

function fmtElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(2)}s`;
  return `${(ms / 1000).toFixed(1)}s`;
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
