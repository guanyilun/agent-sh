import { Markdown, Text, type Component, type MarkdownTheme } from "@earendil-works/pi-tui";
import { c } from "./theme.js";

export class UserMessage implements Component {
  private text: Text;
  constructor(query: string) {
    this.text = new Text(`${c.user("> ")}${query}`, 1, 0);
  }
  render(width: number) { return this.text.render(width); }
  invalidate() { this.text.invalidate(); }
}

export class AssistantMessage implements Component {
  private md: Markdown;
  private buffer = "";
  constructor(theme: MarkdownTheme) {
    this.md = new Markdown("", 1, 0, theme);
  }
  appendText(t: string) {
    this.buffer += t;
    this.md.setText(this.buffer);
  }
  appendCodeBlock(language: string, code: string) {
    const fence = "```";
    const prefix = this.buffer && !this.buffer.endsWith("\n") ? "\n" : "";
    this.buffer += `${prefix}${fence}${language}\n${code}\n${fence}\n`;
    this.md.setText(this.buffer);
  }
  finalize() {
    if (this.buffer === "") this.buffer = " ";
    this.md.setText(this.buffer);
  }
  hasContent() { return this.buffer.trim().length > 0; }
  render(width: number) { return this.md.render(width); }
  invalidate() { this.md.invalidate(); }
}

export class ToolExecution implements Component {
  private title: string;
  private detail?: string;
  private exitCode: number | null | undefined;
  private elapsedMs?: number;
  private startedAt: number;
  private summary?: string;
  constructor(title: string, detail?: string) {
    this.title = title;
    this.detail = detail;
    this.startedAt = Date.now();
  }
  complete(exitCode: number | null, summary?: string) {
    this.exitCode = exitCode;
    this.elapsedMs = Date.now() - this.startedAt;
    this.summary = summary;
  }
  render(_width: number): string[] {
    const head = `${c.toolName("◆")} ${c.toolName(this.title)}${this.detail ? ` ${c.toolDetail(this.detail)}` : ""}`;
    const lines = [` ${head}`];
    if (this.exitCode === undefined) {
      lines.push(`   ${c.muted("…")}`);
    } else {
      const ok = this.exitCode === null || this.exitCode === 0;
      const mark = ok ? c.ok("✓") : c.error("✗");
      const elapsed = this.elapsedMs !== undefined ? c.muted(`${(this.elapsedMs / 1000).toFixed(1)}s`) : "";
      const tail = this.summary ? ` ${c.muted(this.summary)}` : "";
      lines.push(`   ${mark} ${elapsed}${tail}`);
    }
    return lines;
  }
  invalidate() {}
}

export class ErrorLine implements Component {
  private text: Text;
  constructor(message: string) {
    this.text = new Text(` ${c.error("✗")} ${c.error(message)}`, 0, 0);
  }
  render(width: number) { return this.text.render(width); }
  invalidate() { this.text.invalidate(); }
}

export class InfoLine implements Component {
  private text: Text;
  constructor(message: string) {
    this.text = new Text(` ${c.muted(message)}`, 0, 0);
  }
  render(width: number) { return this.text.render(width); }
  invalidate() { this.text.invalidate(); }
}
