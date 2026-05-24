// Ashi-targeting renderer for the scheme_eval tool. Optional companion to
// the `scheme` extension: hooks into ashi's render-tool-call:* and
// render-tool-result:* namespaces and never imports ashi internals — pi-tui
// primitives and the public hook contract (duck-typed below) are the only
// shared surface.
//
// If ashi isn't the active frontend, the define() calls are inert handlers.
// If the scheme extension isn't loaded, the handlers exist but never fire.

import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { highlight, supportsLanguage } from "cli-highlight";
import type { AgentContext } from "agent-sh/types";

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
  red: "\x1b[31m",
};
const dim = (s: string): string => `${ANSI.dim}${s}${ANSI.reset}`;
const bold = (s: string): string => `${ANSI.bold}${s}${ANSI.reset}`;

function highlightSource(src: string): string {
  if (!supportsLanguage("scheme")) return src;
  try { return highlight(src, { language: "scheme", ignoreIllegals: true }); }
  catch { return src; }
}

function compactPreview(src: string, max = 80): string {
  const compact = src.replace(/\s+/g, " ").trim();
  return compact.length > max ? compact.slice(0, max - 1) + "…" : compact;
}

function parseRaw(raw: unknown): Record<string, unknown> {
  if (typeof raw === "string") {
    try { return JSON.parse(raw) as Record<string, unknown>; } catch { return {}; }
  }
  if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  return {};
}

function sourceFromArgs(args: { rawInput?: unknown }): string {
  const raw = parseRaw(args.rawInput);
  return typeof raw.source === "string" ? raw.source : "";
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

// Implements ashi's ToolCallView: a pi-tui Component with setStatus(opts).
class SchemeCallLine extends Container {
  private line: Text;
  private status: { exitCode: number | null; elapsedMs: number; summary?: string } | undefined;
  private source: string;

  constructor(source: string) {
    super();
    this.source = source;
    this.line = new Text("", 1, 0);
    this.addChild(new Spacer(1));
    this.addChild(this.line);
    this.repaint();
  }

  setStatus(opts: { exitCode: number | null; elapsedMs: number; summary?: string }): void {
    this.status = opts;
    this.repaint();
  }

  private statusTail(): string {
    if (!this.status) return `  ${dim("…")}`;
    const ok = this.status.exitCode === null || this.status.exitCode === 0;
    const mark = ok ? `${ANSI.green}✓${ANSI.reset}` : `${ANSI.red}✗${ANSI.reset}`;
    const elapsed = this.status.elapsedMs > 0 ? ` ${dim(formatElapsed(this.status.elapsedMs))}` : "";
    const sum = this.status.summary ? ` ${dim(this.status.summary)}` : "";
    return `  ${mark}${elapsed}${sum}`;
  }

  private repaint(): void {
    const head = `${ANSI.yellow}λ${ANSI.reset} ${bold("scheme")} `;
    const preview = highlightSource(compactPreview(this.source));
    this.line.setText(`${head}${preview}${this.statusTail()}`);
  }
}

// Implements ashi's ToolResultView. On success, source is hidden until Ctrl+O.
// On failure, auto-expands to show source + the error message — the LLM still
// gets full content via tool_result, but the user needs to see what went wrong.
class SchemeResultBody extends Container {
  private body: Text;
  private source: string;
  private expanded = false;
  private outputBuf = "";
  private exitCode: number | null | undefined;

  constructor(source: string) {
    super();
    this.source = source;
    this.body = new Text("", 1, 0);
    this.addChild(this.body);
  }

  appendChunk(chunk: string): void {
    this.outputBuf += chunk;
    if (this.expanded) this.repaint();
  }
  setDiffRenderer(_fn: (width: number) => string[]): void { /* not a file-edit tool */ }
  finalize(opts: { exitCode: number | null; summary?: string }): void {
    this.exitCode = opts.exitCode;
    const failed = opts.exitCode !== null && opts.exitCode !== 0;
    if (failed) this.expanded = true;
    this.repaint();
  }

  toggleExpanded(): void {
    this.expanded = !this.expanded;
    this.repaint();
  }

  private failed(): boolean {
    return this.exitCode !== undefined && this.exitCode !== null && this.exitCode !== 0;
  }

  private repaint(): void {
    if (!this.expanded) { this.body.setText(""); return; }
    const src = this.source ? highlightSource(this.source) : "";
    if (this.failed() && this.outputBuf) {
      const err = `${ANSI.red}✗${ANSI.reset} ${this.outputBuf.trim()}`;
      this.body.setText(src ? `${src}\n\n${err}` : err);
      return;
    }
    this.body.setText(src);
  }
}

export default function activate(ctx: AgentContext): void {
  // ashi looks up render hooks by the title agent-sh emits in tool-started,
  // which is tool.displayName ?? tool.name. scheme.ts sets name="scheme_eval"
  // and displayName="scheme", so we register under both — matching how ashi's
  // own renderers handle read_file/read, edit_file/edit, etc.
  for (const n of ["scheme", "scheme_eval"]) {
    ctx.define(
      `ashi:render-tool-call:${n}`,
      (args: { rawInput?: unknown }) => new SchemeCallLine(sourceFromArgs(args)),
    );
    ctx.define(
      `ashi:render-tool-result:${n}`,
      (args: { rawInput?: unknown }) => new SchemeResultBody(sourceFromArgs(args)),
    );
  }
}
