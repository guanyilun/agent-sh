// Declarative render schema for tool-call hooks: data types + the ANSI projection
// of a Body to styled strings, with no TUI-renderer dependency.

import { theme } from "./theme.js";
import { highlight, supportsLanguage } from "cli-highlight";
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

/** `mode`, `previewLines`, `expandedLines` come from ashi.display.{name}. */
export interface Env {
  width: number;
  expanded: boolean;
  finalized: boolean;
  mode: "preview" | "summary" | "hidden";
  previewLines: number;
  expandedLines?: number;
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

export interface MountArgs {
  toolCallId: string;
  name: string;
  title: string;
  kind?: string;
  displayDetail?: string;
  rawInput?: unknown;
}

export interface MountEnv {
  width: number;
  mode: Env["mode"];
  previewLines: number;
  expandedLines?: number;
}

/** Width-aware diff cache: the edit/write tool supplies `fn` at finalize and
 *  renderBody memoizes the last width's output. Shared between this projection
 *  and the renderer's mount cell. */
export interface DiffSlot {
  fn?: (width: number) => string[];
  lastWidth: number;
  cached: string[];
}

// ANSI projection: the sole place that knows about theme colors + highlighting;
// renderers stay pure-data.

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

export function segmentsToString(segs: Segment[]): string {
  return segs.map(styleSegment).join("");
}

const TITLE_ICON_GLYPH: Record<TitleIcon, string> = {
  read: "◆", search: "⌕", edit: "✎", shell: "$", scheme: "λ", generic: "⚙",
};

export function iconString(icon?: TitleIcon): string {
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

export function statusSuffix(s?: DisplayStatus): string {
  if (!s) return `  ${theme.fg("muted", "…")}`;
  const ok = s.exitCode === null || s.exitCode === 0;
  const mark = ok ? theme.fg("success", "✓") : theme.fg("error", "✗");
  const elapsed = s.elapsedMs > 0 ? ` ${theme.fg("muted", fmtElapsed(s.elapsedMs))}` : "";
  const sum = s.summary ? ` ${theme.fg("muted", s.summary)}` : "";
  return `  ${mark}${elapsed}${sum}`;
}

export function renderBody(body: Body, env: Env, diff: DiffSlot): string {
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
      return renderStream(body.text, env);
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
      return body.parts.map((p) => renderBody(p, env, diff)).join("\n\n");
  }
}

// Even when expanded, the tail is capped (ashi.display.{name}.expandedLines) so
// Ctrl+O on a huge result can't flood the scrollback. The agent still sees it all.
const DEFAULT_EXPANDED_LINES = 200;

// Host-wide preview/summary/hidden policy for every kind:"stream" body.
function renderStream(buffer: string, env: Env): string {
  const display = buffer.replace(/\n+$/, "");
  if (env.expanded) {
    const cap = env.expandedLines ?? DEFAULT_EXPANDED_LINES;
    const lines = display.split("\n");
    if (lines.length <= cap) return theme.fg("toolOutput", display);
    const hidden = lines.length - cap;
    const note = theme.fg("muted", `... (${hidden} earlier lines hidden, ${lines.length} total)`);
    return `${note}\n${theme.fg("toolOutput", lines.slice(-cap).join("\n"))}`;
  }
  if (env.mode === "hidden") {
    if (!env.finalized) return "";
    return lineCountHint(buffer);
  }
  if (env.mode === "summary") {
    if (!env.finalized) {
      const tail = display.split("\n").slice(-2).join("\n");
      return theme.fg("muted", tail);
    }
    return lineCountHint(buffer);
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

function lineCountHint(buffer: string): string {
  const lines = buffer.split("\n").filter((l) => l.length > 0);
  const label = lines.length === 1 ? "1 line" : `${lines.length} lines`;
  return theme.fg("muted", label);
}
