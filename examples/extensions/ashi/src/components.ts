import {
  Box,
  Container,
  Markdown,
  type MarkdownTheme,
  Spacer,
  Text,
  type Component,
} from "@earendil-works/pi-tui";
import { iconFor, markdownTheme, theme } from "./theme.js";

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

/** paddingY=0 so the Markdown sits flush against the following tool box,
 *  matching pi's vertical rhythm. */
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

export class ToolExecution extends Container {
  private box: Box;
  private header: Text;
  private outputText: Text;
  private outputBuffer = "";
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
    this.box = new Box(1, 1, (t) => theme.bg("toolPendingBg", t));
    this.header = new Text("", 0, 0);
    this.outputText = new Text("", 0, 0);
    this.box.addChild(this.header);
    this.box.addChild(this.outputText);
    this.addChild(new Spacer(1));
    this.addChild(this.box);
    this.repaint();
  }

  appendOutput(chunk: string): void {
    this.outputBuffer += chunk;
    this.repaint();
  }

  complete(exitCode: number | null, summary?: string): void {
    this.exitCode = exitCode;
    this.elapsedMs = Date.now() - this.startedAt;
    this.summary = summary;
    const ok = exitCode === null || exitCode === 0;
    this.box.setBgFn((t) => theme.bg(ok ? "toolSuccessBg" : "toolErrorBg", t));
    this.repaint();
  }

  private repaint(): void {
    const icon = iconFor(this.kind);
    const titlePart = theme.bold(theme.fg("toolTitle", `${icon} ${this.title}`));
    const detailPart = this.detail ? ` ${theme.fg("muted", this.detail)}` : "";
    let tailPart = "";
    if (this.exitCode !== undefined) {
      const ok = this.exitCode === null || this.exitCode === 0;
      const mark = ok ? theme.fg("success", "✓") : theme.fg("error", "✗");
      const elapsed = this.elapsedMs !== undefined ? ` ${theme.fg("muted", `${(this.elapsedMs / 1000).toFixed(1)}s`)}` : "";
      const sum = this.summary ? ` ${theme.fg("muted", this.summary)}` : "";
      tailPart = `   ${mark}${elapsed}${sum}`;
    } else {
      tailPart = `   ${theme.fg("muted", "…")}`;
    }
    this.header.setText(`${titlePart}${detailPart}\n${tailPart}`);
    if (this.outputBuffer) {
      const trimmed = this.outputBuffer.split("\n").slice(-8).join("\n");
      this.outputText.setText(theme.fg("toolOutput", trimmed));
    } else {
      this.outputText.setText("");
    }
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
