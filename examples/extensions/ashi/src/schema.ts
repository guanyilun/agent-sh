// Declarative render schema for tool-call hooks. External renderers register
// `ctx.define("ashi:render-tool:<name>", () => ({ initial, reducers, view }))`.

import { Container, Spacer, Text, visibleWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import type { ThemeColor } from "./theme.js";
import type { ToolEntryConfig } from "./display-config.js";

export type { ToolEntryConfig, ToolResultMode } from "./display-config.js";

export type Color = ThemeColor;

export interface StyleHint {
  color?: Color;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
}

export type Segment = string | { text: string; style?: StyleHint; highlight?: string };

export type Body =
  | { kind: "text"; segments: Segment[] }
  | { kind: "code"; lang?: string; text: string }
  /** Width-aware renderer is supplied via setDiffRenderer; view() opts in by
   *  returning { kind: "diff" } and gating on hasDiff in state. */
  | { kind: "diff" }
  | { kind: "stream"; text: string }
  | { kind: "lines"; lines: Segment[][] }
  | { kind: "compound"; parts: Body[] };

export interface DisplayStatus {
  exitCode: number | null;
  elapsedMs: number;
  summary?: string;
}

/** Renderers pick a category; ashi picks the glyph. Falls back to generic. */
export type TitleIcon = "read" | "search" | "edit" | "shell" | "generic" | "scheme";

export interface ToolDisplay {
  titleIcon?: TitleIcon;
  title: Segment[];
  /** Right-aligned on the title line; framework handles padding and reserves
   *  space for the status suffix so renderers don't compute widths. */
  titleRight?: Segment[];
  status?: DisplayStatus;
  body?: Body;
  expandable?: boolean;
  defaultExpanded?: boolean;
}

/** `mode` and `previewLines` come from ashi.display.{name} (display-config.ts). */
export interface Env {
  width: number;
  expanded: boolean;
  finalized: boolean;
  mode: "preview" | "summary" | "hidden";
  previewLines: number;
}

export type Reducer<S, P = unknown> = (state: S, payload: P) => S;

/** Framework tracks `output`, `status`, `hasDiff` — renderers don't wire
 *  `chunk` / `status` / `diff` reducers themselves. */
export type ViewState<S> = S & {
  output: string;
  status?: DisplayStatus;
  hasDiff: boolean;
};

export interface RenderInitArgs {
  rawInput?: unknown;
  name: string;
  title: string;
  kind?: string;
  displayDetail?: string;
}

export interface RenderModel<S = Record<string, never>> {
  initial: (args: RenderInitArgs) => S;
  /** Only for tool-specific state transitions; `status`/`chunk` are framework-tracked. */
  reducers?: Record<string, Reducer<ViewState<S>, never>>;
  view: (state: ViewState<S>, env: Env) => ToolDisplay;
  display?: Partial<ToolEntryConfig>;
}

export function isRenderModel(v: unknown): v is RenderModel<unknown> {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o.initial === "function" && typeof o.view === "function";
}

// Call-side and result-side components share one state cell, so chunks from
// the result side can repaint the call line (e.g. for in-title progress).

import { theme } from "./theme.js";

interface DiffSlot {
  fn?: (width: number) => string[];
  lastWidth: number;
  cached: string[];
}

interface SharedCell<S> {
  state: S;
  env: Env;
  diff: DiffSlot;
  callView?: SchemaCallComponent;
  resultView?: SchemaResultComponent;
}

interface RenderHandle<S> {
  cell: SharedCell<S>;
  model: RenderModel<S>;
  toolCallId: string;
  dispatch: (action: string, payload?: unknown) => void;
}

/** Lets the result-side mount find the call-side cell. Cleared on finalize. */
const HANDLES = new Map<string, RenderHandle<unknown>>();

export interface MountArgs {
  toolCallId: string;
  name: string;
  title: string;
  kind?: string;
  displayDetail?: string;
  rawInput?: unknown;
}

function handleFor<S>(
  args: MountArgs,
  model: RenderModel<S>,
  envInit: { width: number; mode: Env["mode"]; previewLines: number },
): RenderHandle<S> {
  const existing = HANDLES.get(args.toolCallId) as RenderHandle<S> | undefined;
  if (existing) return existing;
  const userInitial = model.initial({
    rawInput: args.rawInput,
    name: args.name,
    title: args.title,
    kind: args.kind,
    displayDetail: args.displayDetail,
  });
  const cell: SharedCell<ViewState<S>> = {
    state: { ...(userInitial as object), output: "", hasDiff: false } as ViewState<S>,
    env: { ...envInit, expanded: false, finalized: false },
    diff: { lastWidth: -1, cached: [] },
  };
  const reducers = model.reducers ?? {};
  const handle: RenderHandle<ViewState<S>> = {
    cell,
    model: model as unknown as RenderModel<ViewState<S>>,
    toolCallId: args.toolCallId,
    dispatch(action, payload) {
      if (action === "status") {
        cell.state = { ...cell.state, status: payload as DisplayStatus };
      } else if (action === "chunk") {
        cell.state = { ...cell.state, output: cell.state.output + (payload as string) };
      } else if (action === "diff") {
        cell.diff = { fn: payload as (w: number) => string[], lastWidth: -1, cached: [] };
        cell.state = { ...cell.state, hasDiff: true };
      } else {
        const reducer = reducers[action];
        if (!reducer) return;
        cell.state = (reducer as Reducer<ViewState<S>, unknown>)(cell.state, payload);
      }
      cell.callView?.repaint();
      cell.resultView?.repaint();
    },
  };
  HANDLES.set(args.toolCallId, handle as unknown as RenderHandle<unknown>);
  return handle as unknown as RenderHandle<S>;
}

// Sole place that knows about theme colors + highlighting; renderers stay pure-data.

import { highlight, supportsLanguage } from "cli-highlight";

function styleSegment(seg: Segment): string {
  if (typeof seg === "string") return seg;
  let text = seg.text;
  if (seg.highlight && supportsLanguage(seg.highlight)) {
    try { text = highlight(text, { language: seg.highlight, ignoreIllegals: true }); }
    catch { /* fall through */ }
  }
  const s = seg.style;
  if (!s) return text;
  if (s.color) text = theme.fg(s.color, text);
  if (s.bold) text = theme.bold(text);
  if (s.italic) text = theme.italic(text);
  if (s.dim) text = theme.fg("dim", text);
  return text;
}

function segmentsToString(segs: Segment[]): string {
  return segs.map(styleSegment).join("");
}

const TITLE_ICON_GLYPH: Record<TitleIcon, string> = {
  read: "◆", search: "⌕", edit: "✎", shell: "$", scheme: "λ", generic: "⚙",
};

function iconString(icon?: TitleIcon): string {
  if (!icon) return "";
  return `${theme.fg("warning", TITLE_ICON_GLYPH[icon])} `;
}

function fmtElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(2)}s`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const totalSeconds = Math.floor(ms / 1000);
  return `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s`;
}

function statusSuffix(s?: DisplayStatus): string {
  if (!s) return `  ${theme.fg("muted", "…")}`;
  const ok = s.exitCode === null || s.exitCode === 0;
  const mark = ok ? theme.fg("success", "✓") : theme.fg("error", "✗");
  const elapsed = s.elapsedMs > 0 ? ` ${theme.fg("muted", fmtElapsed(s.elapsedMs))}` : "";
  const sum = s.summary ? ` ${theme.fg("muted", s.summary)}` : "";
  return `  ${mark}${elapsed}${sum}`;
}

function renderBody(body: Body, env: Env, diff: DiffSlot, exitCode?: number | null): string {
  switch (body.kind) {
    case "text":
      return segmentsToString(body.segments);
    case "code": {
      if (body.lang && supportsLanguage(body.lang)) {
        try { return highlight(body.text, { language: body.lang, ignoreIllegals: true }); }
        catch { /* fall through */ }
      }
      return body.text;
    }
    case "stream":
      return renderStream(body.text, env, exitCode);
    case "lines":
      return body.lines.map(segmentsToString).join("\n");
    case "diff": {
      if (!diff.fn) return "";
      if (diff.lastWidth !== env.width) {
        diff.cached = diff.fn(env.width);
        diff.lastWidth = env.width;
      }
      return diff.cached.join("\n");
    }
    case "compound":
      return body.parts.map((p) => renderBody(p, env, diff, exitCode)).join("\n\n");
  }
}

// Host-wide preview/summary/hidden policy inherited by every kind:"stream" body.
function renderStream(buffer: string, env: Env, exitCode: number | null | undefined): string {
  const display = buffer.replace(/\n+$/, "");
  if (env.expanded) return theme.fg("toolOutput", display);
  if (env.mode === "hidden") {
    if (!env.finalized) return "";
    return lineCountHint(buffer, exitCode);
  }
  if (env.mode === "summary") {
    if (!env.finalized) {
      const tail = display.split("\n").slice(-2).join("\n");
      return theme.fg("muted", tail);
    }
    return lineCountHint(buffer, exitCode);
  }
  if (!display) return "";
  const lines = display.split("\n");
  const trimmed = lines.slice(-env.previewLines).join("\n");
  const remaining = Math.max(0, lines.length - env.previewLines);
  const overflow = remaining > 0
    ? `\n${theme.fg("muted", `... (${remaining} more ${remaining === 1 ? "line" : "lines"})`)}`
    : "";
  return `${theme.fg("toolOutput", trimmed)}${overflow}`;
}

function lineCountHint(buffer: string, exitCode: number | null | undefined): string {
  const lines = buffer.split("\n").filter((l) => l.length > 0);
  const label = lines.length === 1 ? "1 line" : `${lines.length} lines`;
  const ok = exitCode === null || exitCode === 0;
  const arrow = ok ? theme.fg("muted", "↳ ") : theme.fg("error", "↳ ");
  return `${arrow}${theme.fg("muted", label)}`;
}

// Components that satisfy the legacy ToolCallView / ToolResultView contracts.

class SchemaCallComponent extends Container {
  private line: Text;
  constructor(private handle: RenderHandle<unknown>) {
    super();
    this.line = new Text("", 1, 0);
    this.addChild(new Spacer(1));
    this.addChild(this.line);
    handle.cell.callView = this;
    this.repaint();
  }

  setStatus(opts: { exitCode: number | null; elapsedMs: number; summary?: string }): void {
    this.handle.dispatch("status", opts);
  }

  repaint(): void {
    const display = this.handle.model.view(this.handle.cell.state as ViewState<unknown>, this.handle.cell.env);
    const icon = iconString(display.titleIcon);
    const title = segmentsToString(display.title);
    const status = statusSuffix(display.status);
    if (display.titleRight && display.titleRight.length > 0) {
      const right = segmentsToString(display.titleRight);
      // env.width − 2 accounts for Text's paddingX=1 on each side.
      const used = visibleWidth(icon) + visibleWidth(title) + visibleWidth(status) + visibleWidth(right);
      const pad = " ".repeat(Math.max(2, this.handle.cell.env.width - 2 - used));
      this.line.setText(`${icon}${title}${status}${pad}${right}`);
    } else {
      this.line.setText(`${icon}${title}${status}`);
    }
  }
}

class SchemaResultComponent extends Container {
  private body: Text;
  constructor(private handle: RenderHandle<unknown>) {
    super();
    this.body = new Text("", 0, 0);
    this.addChild(this.body);
    handle.cell.resultView = this;
    this.repaint();
  }

  appendChunk(chunk: string): void { this.handle.dispatch("chunk", chunk); }
  setDiffRenderer(fn: (width: number) => string[]): void { this.handle.dispatch("diff", fn); }
  finalize(opts: { exitCode: number | null; summary?: string }): void {
    this.handle.cell.env = { ...this.handle.cell.env, finalized: true };
    this.handle.dispatch("status", { ...opts, elapsedMs: 0 });
    HANDLES.delete(this.handle.toolCallId);
  }
  toggleExpanded(): void {
    this.handle.cell.env = { ...this.handle.cell.env, expanded: !this.handle.cell.env.expanded };
    this.repaint();
    this.handle.cell.callView?.repaint();
  }

  override render(width: number): string[] {
    if (this.handle.cell.env.width !== width) {
      this.handle.cell.env = { ...this.handle.cell.env, width };
      this.repaint();
    }
    return super.render(width);
  }

  repaint(): void {
    const env = this.handle.cell.env;
    const display = this.handle.model.view(this.handle.cell.state as ViewState<unknown>, env);
    if (!display.body) { this.body.setText(""); return; }
    // stream embeds the preview/summary/hidden policy; diff shows in preview
    // or when expanded; other kinds show only when expanded/defaultExpanded.
    if (display.body.kind === "diff" && !env.expanded && env.mode !== "preview") {
      this.body.setText("");
      return;
    }
    const policied = display.body.kind === "stream" || display.body.kind === "diff";
    if (!policied && !env.expanded && !display.defaultExpanded) {
      this.body.setText("");
      return;
    }
    this.body.setText(renderBody(display.body, env, this.handle.cell.diff, display.status?.exitCode));
  }
}

export interface MountEnv {
  width: number;
  mode: Env["mode"];
  previewLines: number;
}

export function mountCall<S>(model: RenderModel<S>, args: MountArgs, env: MountEnv): Component {
  const handle = handleFor(args, model, env);
  return new SchemaCallComponent(handle as RenderHandle<unknown>);
}

export function mountResult<S>(model: RenderModel<S>, args: MountArgs, env: MountEnv): Component {
  const handle = handleFor(args, model, env);
  return new SchemaResultComponent(handle as RenderHandle<unknown>);
}
