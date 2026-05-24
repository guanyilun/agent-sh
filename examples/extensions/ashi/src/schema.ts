// Declarative render schema for tool-call hooks.
//
// External renderers register one hook per tool:
//   ctx.define("ashi:render-tool:scheme", () => ({ initial, reducers, view }))
//
// The view function is pure: `view(state, env)` returns a ToolDisplay describing
// title + status + body. Ashi owns the pi-tui mapping, theming, streaming
// buffer policy, diff reflow on resize, expand/collapse — everything that used
// to leak into renderer subclasses.

import { Container, Text } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import type { ThemeColor } from "./theme.js";

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
  /** Diff body — framework supplies the width-aware renderer via setDiffRenderer
   *  (called from frontend.ts when the edit/write tool finalizes). Renderers
   *  opt in by returning { kind: "diff" } and reading hasDiff from state. */
  | { kind: "diff" }
  | { kind: "stream"; text: string }
  | { kind: "lines"; lines: Segment[][] }
  | { kind: "compound"; parts: Body[] };

export interface DisplayStatus {
  exitCode: number | null;
  elapsedMs: number;
  summary?: string;
}

/** Built-in icon set ashi knows how to theme. Renderers pick a category;
 *  ashi picks the glyph. Falls back to the generic gear if absent. */
export type TitleIcon = "read" | "search" | "edit" | "shell" | "generic" | "scheme";

export interface ToolDisplay {
  titleIcon?: TitleIcon;
  title: Segment[];
  status?: DisplayStatus;
  body?: Body;
  expandable?: boolean;
  defaultExpanded?: boolean;
}

/** What the host tells the view about the rendering environment. Pure:
 *  changes here trigger a re-invocation of view(). `mode` and `previewLines`
 *  come from ashi.display.{name} — see display-config.ts. */
export interface Env {
  width: number;
  expanded: boolean;
  finalized: boolean;
  mode: "preview" | "summary" | "hidden";
  previewLines: number;
}

export type Reducer<S, P = unknown> = (state: S, payload: P) => S;

/** State as seen by view() — the user's S plus framework-tracked output/status.
 *  Renderers never need to wire `chunk` / `status` / `diff` reducers themselves.
 *  hasDiff is true once setDiffRenderer has been called (edit/write tools). */
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
  /** Optional. `status` and `chunk` are tracked by the framework — declare
   *  reducers here only for tool-specific state transitions. */
  reducers?: Record<string, Reducer<ViewState<S>, never>>;
  view: (state: ViewState<S>, env: Env) => ToolDisplay;
}

export function isRenderModel(v: unknown): v is RenderModel<unknown> {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o.initial === "function" && typeof o.view === "function";
}

// ---------------------------------------------------------------------------
// Adapter: model → paired Components for call-side and result-side hooks.
//
// Both Components share a single state cell so that a `chunk` dispatch from
// the result side repaints the call line too (e.g. for renderers that show
// progress in the title).

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

/** Per-toolCallId handle registry — sole purpose is letting the result-side
 *  mount find the call-side cell so they can share state. Once the result
 *  component is mounted, both views hold their own handle reference and the
 *  map entry is dead weight; cleared on finalize. */
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

// ---------------------------------------------------------------------------
// Segment / Body → ANSI string rendering. Lives here so it's the only place
// that knows about theme colors + highlighting; renderers stay pure-data.

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

// Lifted from ToolResultBody.repaint() in components.ts — preview/summary/hidden
// policy is host-wide display config, not per-tool, so it lives here once and
// every schema renderer with a kind:"stream" body inherits it for free.
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

// ---------------------------------------------------------------------------
// Pi-tui Components produced by the adapter. Implement the existing
// ToolCallView / ToolResultView contracts so the ashi resolver doesn't care
// whether a renderer is legacy or schema-style.

class SchemaCallComponent extends Container {
  private line: Text;
  constructor(private handle: RenderHandle<unknown>) {
    super();
    this.line = new Text("", 1, 0);
    this.addChild(this.line);
    handle.cell.callView = this;
    this.repaint();
  }

  setStatus(opts: { exitCode: number | null; elapsedMs: number; summary?: string }): void {
    this.handle.dispatch("status", opts);
  }

  toggleExpanded(): void {
    this.handle.cell.env = { ...this.handle.cell.env, expanded: !this.handle.cell.env.expanded };
    this.repaint();
    this.handle.cell.resultView?.repaint();
  }

  repaint(): void {
    const display = this.handle.model.view(this.handle.cell.state as ViewState<unknown>, this.handle.cell.env);
    const icon = iconString(display.titleIcon);
    const title = segmentsToString(display.title);
    this.line.setText(`${icon}${title}${statusSuffix(display.status)}`);
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
    // kind:"stream" embeds preview/summary/hidden policy.
    // kind:"diff" shows in preview mode or when expanded.
    // Other kinds show iff expanded or the view requested defaultExpanded.
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

// ---------------------------------------------------------------------------
// Public mount functions used by hooks.ts when resolving a schema-style
// renderer. Each returns a Component that satisfies the legacy view contract,
// so the rest of ashi doesn't need to know schema renderers exist.

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
