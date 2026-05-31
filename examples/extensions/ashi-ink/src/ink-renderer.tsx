// Bridges ashi's imperative node tree to Ink via mutable vnodes + a version store.

import React from "react";
import { Box, Static, Text, render as inkRender, type Instance } from "ink";
import Spinner from "ink-spinner";
import { LineEditor } from "agent-sh/utils/line-editor.js";
import { ProcessTerminal, matchesKey, isKeyRelease, isKeyRepeat, wrapTextWithAnsi, type KeyId } from "@earendil-works/pi-tui";
import { Marked } from "marked";
import { markedTerminal } from "marked-terminal";
import Table from "cli-table3";
import {
  renderBody,
  segmentsToString,
  type DiffSlot,
  type Env,
  type MountArgs,
  type MountEnv,
  type Reducer,
  type RenderModel,
  type ToolDisplay,
  type ViewState,
} from "@guanyilun/ashi/render";
import type {
  App,
  ContainerView,
  InputView,
  KeyEvent,
  KeyHandler,
  LoaderView,
  MarkdownOptions,
  MarkdownView,
  RenderNode,
  Renderer,
  RenderNodes,
  SelectItem,
  SelectView,
  TextView,
  ToolCallView,
  ToolGroupModel,
  ToolGroupView,
  ToolResultView,
} from "@guanyilun/ashi/renderer";

interface SelectState {
  items: SelectItem[];
  index: number;
  visibleRows: number;
  highlighted?: SelectItem;
  onSelect: (item: SelectItem) => void;
  onCancel: () => void;
}

type VNode =
  | { kind: "text"; lines: string[]; fn: ((width: number) => string[]) | null; paddingX?: number; cont?: boolean }
  | { kind: "markdown"; source: string; color?: (t: string) => string; userMsg?: boolean; bullet?: boolean; paddingX?: number; mdc?: MdCache }
  | { kind: "spacer"; rows: number }
  | { kind: "container"; children: VNode[] }
  | { kind: "loader"; label: string }
  | { kind: "select"; state: SelectState };

const asNode = (v: VNode): RenderNode => v as unknown as RenderNode;
const asV = (n: RenderNode): VNode => n as unknown as VNode;

const ANSI = /\x1b\[[0-9;]*m/g;
const measureWidth = (text: string): number => text.replace(ANSI, "").length;
const termWidth = (): number => process.stdout.columns ?? 80;

// Ink closes an open SGR at each newline and never reopens it, so a multi-line color
// span tints only the first line — re-emit the active SGR after every newline.
const SGR_RESETS = new Set(["\x1b[0m", "\x1b[m", "\x1b[39m", "\x1b[49m", "\x1b[22m"]);
function carrySgr(text: string): string {
  if (!text.includes("\n")) return text;
  let active = "";
  return text.split("\n").map((line) => {
    const out = active + line;
    for (const code of line.match(ANSI) ?? []) active = SGR_RESETS.has(code) ? "" : active + code;
    return out;
  }).join("\n");
}

function truncateVisible(s: string, width: number): string {
  if (width <= 1 || measureWidth(s) <= width) return s;
  let visible = 0;
  let out = "";
  for (const m of s.matchAll(/\x1b\[[0-9;]*m|[\s\S]/g)) {
    const tok = m[0];
    if (tok[0] === "\x1b") { out += tok; continue; }
    if (visible >= width - 1) break;
    out += tok;
    visible++;
  }
  return `${out}…\x1b[0m`;
}

const ACCENT_HEX = "#c778dd"; // loader spinner + focused input border
const RESET = "\x1b[39m";
const BOLD = "\x1b[1m";
const BOLD_OFF = "\x1b[22m";
const USER_BG = "#3a3a42";
const MARKER_GRAY = "\x1b[38;2;154;160;166m"; // fg-only, safe over the band bg
const MARKER_GRAY_HEX = "#9aa0a6";
const USER_MARKER = `${MARKER_GRAY}${BOLD}❯${BOLD_OFF}${RESET} `;
const ASSISTANT_MARKER = "⏺ ";
const CURSOR_ON = "\x1b[7m"; // inverse video — the text cursor block
const CURSOR_OFF = "\x1b[27m";

// Fixed dark-theme dot colors, intentionally distinct from ashi's palette.
const DOT_OK = "\x1b[38;2;78;186;101m";
const DOT_ERR = "\x1b[38;2;255;107;128m";
const DIM_ON = "\x1b[2m";
const DIM_OFF = "\x1b[22m";

// The frontend hands border color as a text styler (theme.fg truecolor); Ink's
// borderColor wants a value, so pull the RGB back out as hex.
function hexFromStyler(fn: (t: string) => string): string {
  const m = fn("x").match(/38;2;(\d+);(\d+);(\d+)/);
  return m ? `#${[m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, "0")).join("")}` : MARKER_GRAY_HEX;
}

// marked-terminal's legacy table renderer hands us marker-delimited cells sized to
// content with no max; we split them and rebuild with cli-table3 colWidths that fit.
const TABLE_CELL_SPLIT = "^*||*^";
const TABLE_ROW_WRAP_RE = /\*\|\*\|\*\|\*/g;

function splitTableRows(text: string): string[][] {
  if (!text) return [];
  return text.split("\n").filter(Boolean).map((l) => {
    const cells = l.replace(TABLE_ROW_WRAP_RE, "").split(TABLE_CELL_SPLIT);
    return cells.slice(0, cells.length - 1); // trailing split is empty
  });
}

function fitTable(header: string, body: string, width: number): string {
  const head = splitTableRows(header)[0] ?? [];
  const rows = splitTableRows(body);
  const cols = Math.max(1, head.length);
  const overhead = cols + 1 + cols * 2; // borders + 1-cell padding each side
  // Grow to content width; only shrink+wrap once it would exceed the terminal.
  const natural = Array.from({ length: cols }, (_, i) => {
    let mx = measureWidth(head[i] ?? "");
    for (const r of rows) mx = Math.max(mx, measureWidth(r[i] ?? ""));
    return Math.max(1, mx);
  });
  let colWidths: number[];
  if (natural.reduce((a, b) => a + b, 0) + overhead <= width) {
    colWidths = natural.map((n) => n + 2); // +2 = the 1-cell padding each side
  } else {
    const content = Math.max(cols * 3, width - overhead);
    const base = Math.floor(content / cols);
    const rem = content % cols;
    colWidths = Array.from({ length: cols }, (_, i) => base + (i < rem ? 1 : 0) + 2);
  }
  const t = new Table({ head, colWidths, wordWrap: true, wrapOnWordBoundary: true, style: { head: [] } });
  for (const row of rows) t.push(row);
  return `${t.toString()}\n`;
}

// marked-terminal doesn't reflow list items; reflow each so its list() hang-indents the wraps.
function makeWrappingList(width: number) {
  return (body: string, ordered: boolean): string => {
    const out: string[] = [];
    let num = 0;
    let hang = 2;
    for (const line of body.trim().split("\n")) {
      if (!line) continue;
      if (line.startsWith("* ")) {
        const marker = ordered ? `${++num}. ` : "* ";
        hang = marker.length;
        wrapTextWithAnsi(line.slice(2), Math.max(1, width - hang))
          .forEach((wl, i) => out.push((i === 0 ? marker : " ".repeat(hang)) + wl));
      } else {
        wrapTextWithAnsi(line, Math.max(1, width - hang)).forEach((wl) => out.push(" ".repeat(hang) + wl));
      }
    }
    return out.join("\n");
  };
}

// marked-terminal defaults to width 80 / no reflow; reflow at the real width (cached).
const markedCache = new Map<number, Marked>();
function markedFor(width: number): Marked {
  let m = markedCache.get(width);
  if (!m) {
    m = new Marked();
    // tab 0 = flush-left markdown (the bullet is the only indent); flattens nested lists.
    m.use(markedTerminal({ width, reflowText: true, tab: 0, list: makeWrappingList(width) }) as Parameters<Marked["use"]>[0]);
    m.use({ renderer: { table: (h: unknown, b: unknown): string => fitTable(String(h), String(b), width) } } as Parameters<Marked["use"]>[0]);
    markedCache.set(width, m);
  }
  return m;
}
function renderMarkdown(src: string, width: number): string {
  try {
    return String(markedFor(Math.max(20, width)).parse(src)).replace(/\n+$/, "");
  } catch {
    return src;
  }
}

// Stable-prefix streaming: render only the unstable tail and cache completed blocks
// (the boundary only advances), so a long stream isn't re-parsed every frame. marked
// keeps an unclosed fence as one token, so the boundary never splits a block.
interface MdCache { src: string; out: string; w: number }
const blockLexer = new Marked();
function renderMarkdownStreaming(v: { source: string; mdc?: MdCache }, width: number): string {
  const src = v.source;
  let c = v.mdc;
  if (!c || c.w !== width || !src.startsWith(c.src)) c = v.mdc = { src: "", out: "", w: width };
  let advance = 0;
  try {
    const toks = blockLexer.lexer(src.slice(c.src.length));
    let last = toks.length - 1;
    while (last >= 0 && toks[last]!.type === "space") last--;
    for (let i = 0; i < last; i++) advance += toks[i]!.raw.length;
  } catch { advance = 0; }
  if (advance > 0) {
    const delta = renderMarkdown(src.slice(c.src.length, c.src.length + advance), width);
    c.out = c.out ? `${c.out}\n\n${delta}` : delta;
    c.src = src.slice(0, c.src.length + advance);
  }
  const tail = src.slice(c.src.length);
  const tailOut = tail.trim() ? renderMarkdown(tail, width) : "";
  if (!c.out) return tailOut;
  if (!tailOut) return c.out;
  return `${c.out}\n\n${tailOut}`;
}

interface Store {
  bump: () => void;
  subscribe: (l: () => void) => () => void;
  get: () => number;
}
function createStore(): Store {
  let version = 0;
  let scheduled = false;
  const listeners = new Set<() => void>();
  let lastFlush = 0;
  const flush = (): void => {
    scheduled = false;
    lastFlush = performance.now();
    version++;
    for (const l of [...listeners]) l();
  };
  return {
    // Timer-throttle to ~60fps. Bursty per-microtask bumps would chain renders past
    // React's nested-update limit ("Maximum update depth"); a macrotask flush
    // collapses a whole burst into one render so the chain can't form.
    bump: () => {
      if (scheduled) return;
      scheduled = true;
      const h = setTimeout(flush, Math.max(0, 16 - (performance.now() - lastFlush)));
      (h as { unref?: () => void }).unref?.();
    },
    subscribe: (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
    get: () => version,
  };
}

// One shared ~600ms clock blinks running dots in sync; it ticks only while something
// runs and unrefs so it never holds the process open (headless tests exit clean).
const BLINK_MS = 600;
interface Blink { on: () => boolean; start: (token: object) => void; stop: (token: object) => void }
function makeBlink(bump: () => void): Blink {
  const active = new Set<object>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let on = true;
  return {
    on: () => on,
    start: (token) => {
      active.add(token);
      if (!timer) {
        timer = setInterval(() => { on = !on; bump(); }, BLINK_MS);
        (timer as { unref?: () => void }).unref?.();
      }
    },
    stop: (token) => {
      active.delete(token);
      if (active.size === 0 && timer) { clearInterval(timer); timer = null; on = true; }
    },
  };
}

function makeNodes(req: () => void): RenderNodes {
  return {
    text(opts?: { paddingX?: number }): TextView {
      const v: VNode = { kind: "text", lines: [], fn: null, paddingX: opts?.paddingX };
      return {
        node: asNode(v),
        setText: (s) => { if (v.kind === "text") { v.lines = s.split("\n"); v.fn = null; } req(); },
        setLines: (lines) => { if (v.kind === "text") { v.lines = lines; v.fn = null; } req(); },
        setRenderFn: (fn) => { if (v.kind === "text") v.fn = fn; req(); },
      };
    },
    markdown(opts?: MarkdownOptions): MarkdownView {
      const v: VNode = { kind: "markdown", source: "", color: opts?.color, userMsg: opts?.osc133Zones, bullet: opts?.bullet, paddingX: opts?.paddingX };
      return {
        node: asNode(v),
        setText: (s) => { if (v.kind === "markdown") v.source = s; req(); },
      };
    },
    image: (): RenderNode | null => null,
    container(): ContainerView {
      const v: VNode = { kind: "container", children: [] };
      const ch = v.kind === "container" ? v.children : [];
      return {
        node: asNode(v),
        addChild: (c) => { ch.push(asV(c)); req(); },
        removeChild: (c) => { const i = ch.indexOf(asV(c)); if (i >= 0) ch.splice(i, 1); req(); },
        clear: () => { ch.length = 0; req(); },
      };
    },
    spacer: (rows: number): RenderNode => asNode({ kind: "spacer", rows }),
  };
}

interface Cell {
  state: ViewState<Record<string, unknown>>;
  env: Env;
  diff: DiffSlot;
  model: RenderModel<unknown>;
  args: MountArgs;
}

// Tool look (ink owns presentation; the schema supplies name/detail/status/body).
const RESULT_GUTTER = "     "; // 5 cols — continuation under "  ⎿  "

function prettyToolName(name: string): string {
  const base = (name || "tool").replace(/_file$/i, "").replace(/[_-]+/g, " ").trim();
  const words = base.split(" ").filter(Boolean).map((w) => w[0]!.toUpperCase() + w.slice(1));
  return words.join(" ") || "Tool";
}

// Dimmed blinking ⏺ while running (a blank keeps the gutter width steady), solid
// green/red once resolved.
function statusDot(s: { exitCode: number | null } | undefined, blinkOn: boolean): string {
  if (!s) return blinkOn ? `${DIM_ON}⏺${DIM_OFF}` : " ";
  const ok = s.exitCode === null || s.exitCode === 0;
  return `${ok ? DOT_OK : DOT_ERR}⏺${RESET}`;
}

function paintCall(cell: Cell, width: number, blinkOn: boolean): string {
  const display = cell.model.view(cell.state, cell.env) as ToolDisplay;
  const bullet = statusDot(display.status, blinkOn);
  const name = prettyToolName(cell.args.name);
  let detail = (cell.args.displayDetail ?? "").trim()
    || segmentsToString(display.title).replace(ANSI, "").replace(/^\$\s*/, "").trim();
  const sum = display.status?.summary;
  const tail = sum ? ` ${segmentsToString([{ text: sum, style: { color: "muted" } }])}` : "";
  const room = Math.max(8, width - 2 - measureWidth(name) - 2 - (sum ? sum.length + 1 : 0));
  if (detail.length > room) detail = `${detail.slice(0, Math.max(1, room - 1))}…`;
  const nameStyled = segmentsToString([{ text: name, style: { bold: true } }]);
  const line = detail ? `${bullet} ${nameStyled}(${detail})${tail}` : `${bullet} ${nameStyled}${tail}`;
  return truncateVisible(line, width);
}

function paintResult(cell: Cell, width: number): string[] {
  const env = { ...cell.env, width };
  const display = cell.model.view(cell.state, env) as ToolDisplay;
  if (!display.body) return [];
  if (display.body.kind === "diff" && !env.expanded && env.mode !== "preview") return [];
  const policied = display.body.kind === "stream" || display.body.kind === "diff";
  if (!policied && !env.expanded && !display.defaultExpanded) return [];
  const bodyEnv: Env = { ...env, width: Math.max(1, width - RESULT_GUTTER.length) };
  const rendered = carrySgr(renderBody(display.body, bodyEnv, cell.diff));
  if (!rendered.trim()) return [];
  const ok = display.status?.exitCode === null || display.status?.exitCode === 0;
  const elbow = segmentsToString([{ text: "⎿", style: { color: ok ? "muted" : "error" } }]);
  const lines = rendered.split("\n");
  lines[0] = `  ${elbow}  ${lines[0]}`;
  for (let i = 1; i < lines.length; i++) lines[i] = `${RESULT_GUTTER}${lines[i]}`;
  return lines.map((l) => truncateVisible(l, width));
}

function makeToolMount(req: () => void, blink: Blink) {
  const handles = new Map<string, Cell>();

  const cellFor = (model: RenderModel<unknown>, args: MountArgs, env: MountEnv): Cell => {
    const existing = handles.get(args.toolCallId);
    if (existing) return existing;
    const initial = model.initial({
      rawInput: args.rawInput, name: args.name, title: args.title,
      kind: args.kind, displayDetail: args.displayDetail,
    }) as Record<string, unknown>;
    const cell: Cell = {
      state: { ...initial, output: "", hasDiff: false } as ViewState<Record<string, unknown>>,
      env: { ...env, expanded: false, finalized: false },
      diff: { lastWidth: -1, cached: [] },
      model,
      args,
    };
    handles.set(args.toolCallId, cell);
    blink.start(cell);
    return cell;
  };

  const dispatch = (cell: Cell, action: string, payload?: unknown): void => {
    const s = cell.state;
    if (action === "status") s.status = payload as ViewState<Record<string, unknown>>["status"];
    else if (action === "chunk") s.output = s.output + (payload as string);
    else if (action === "diff") { cell.diff = { fn: payload as (w: number) => string[], lastWidth: -1, cached: [] }; s.hasDiff = true; }
    else {
      const reducer = (cell.model.reducers ?? {})[action] as Reducer<typeof s, unknown> | undefined;
      if (reducer) cell.state = reducer(s, payload);
    }
    req();
  };

  return {
    mountCall(model: RenderModel<unknown>, args: MountArgs, env: MountEnv): ToolCallView {
      const cell = cellFor(model, args, env);
      const v: VNode = { kind: "text", lines: [], fn: (w) => [paintCall(cell, w, blink.on())], paddingX: 0 };
      return { node: asNode(v), setStatus: (o) => dispatch(cell, "status", o) };
    },
    mountResult(model: RenderModel<unknown>, args: MountArgs, env: MountEnv): ToolResultView {
      const cell = cellFor(model, args, env);
      const v: VNode = { kind: "text", lines: [], fn: (w) => paintResult(cell, w), cont: true };
      return {
        node: asNode(v),
        appendChunk: (c) => dispatch(cell, "chunk", c),
        setDiffRenderer: (fn) => dispatch(cell, "diff", fn),
        finalize: (o) => { cell.env = { ...cell.env, finalized: true }; dispatch(cell, "status", { ...o, elapsedMs: 0 }); handles.delete(args.toolCallId); blink.stop(cell); },
        toggleExpanded: () => { cell.env = { ...cell.env, expanded: !cell.env.expanded }; req(); },
      };
    },
  };
}

function summarizeGroup(kind: string, n: number, running: boolean): string {
  if (kind === "read") return `${running ? "Reading" : "Read"} ${n} file${n === 1 ? "" : "s"}`;
  if (kind === "search") return `${running ? "Searching for" : "Searched for"} ${n} pattern${n === 1 ? "" : "s"}`;
  return `${running ? "Running" : "Ran"} ${n} ${kind} call${n === 1 ? "" : "s"}`;
}
function childOk(c: ToolGroupModel["children"][number]): boolean {
  return !c.status || c.status.exitCode === null || c.status.exitCode === 0;
}
function groupSummaryLine(model: ToolGroupModel, blinkOn: boolean): string {
  const total = model.children.length + (model.hidden?.count ?? 0);
  const anyErr = model.children.some((c) => !childOk(c)) || (model.hidden ? !model.hidden.ok : false);
  const dot = statusDot(model.open ? undefined : { exitCode: anyErr ? 1 : 0 }, blinkOn);
  const hint = model.expanded ? "" : ` ${DIM_ON}(ctrl+o to expand)${DIM_OFF}`;
  return `${dot} ${summarizeGroup(model.kind, total, model.open)}${model.open ? "…" : ""}${hint}`;
}
function makeToolGroup(req: () => void, blink: Blink): ToolGroupView {
  const v: VNode = { kind: "container", children: [] };
  const ch = v.kind === "container" ? v.children : [];
  let model: ToolGroupModel | null = null;
  let acquired = false;
  const update = (m: ToolGroupModel): void => {
    model = m;
    if (m.open && !acquired) { blink.start(v); acquired = true; }
    else if (!m.open && acquired) { blink.stop(v); acquired = false; }
    ch.length = 0;
    // Summary via a render fn so the blink clock repaints it in place.
    ch.push({ kind: "text", lines: [], fn: () => (model ? [groupSummaryLine(model, blink.on())] : []), paddingX: 0 });
    const rows = m.expanded
      ? m.children
      : m.open && m.children.length > 0 ? [m.children[m.children.length - 1]!] : [];
    for (const c of rows) {
      const elbow = segmentsToString([{ text: "⎿", style: { color: childOk(c) ? "muted" : "error" } }]);
      const sum = m.expanded && c.status?.summary ? ` ${segmentsToString([{ text: c.status.summary, style: { color: "muted" } }])}` : "";
      ch.push({ kind: "text", lines: [`  ${elbow}  ${c.detail}${sum}`], fn: null, paddingX: 0 });
    }
    req();
  };
  return { node: asNode(v), update };
}

export function renderVNode(v: VNode, key?: React.Key): React.ReactElement | null {
  switch (v.kind) {
    case "text": {
      const lines = v.fn ? v.fn(termWidth()) : v.lines;
      if (lines.every((l) => l === "")) return null; // empty node is 0 lines, like pi-tui
      const pad = " ".repeat(v.paddingX ?? 0);
      return <Text key={key}>{lines.map((l) => pad + l).join("\n")}</Text>;
    }
    case "markdown": {
      const w = termWidth();
      if (v.userMsg) {
        // Strip ANSI first — marked-terminal's \x1b[0m resets would punch holes in the band bg.
        const plain = renderMarkdown(v.source, w - 2).replace(ANSI, "");
        const banded = plain.split("\n").map((l, i) => {
          const marker = i === 0 ? USER_MARKER : "  ";
          return marker + l + " ".repeat(Math.max(0, w - 2 - l.length));
        }).join("\n");
        return <Text key={key} backgroundColor={USER_BG}>{banded}</Text>;
      }
      if (v.bullet) {
        let md = renderMarkdownStreaming(v, w - 2);
        if (md.replace(ANSI, "").trim() === "") return null;
        if (v.color) md = md.split("\n").map(v.color).join("\n");
        const out = md.split("\n").map((l, i) => (i === 0 ? ASSISTANT_MARKER : "  ") + l).join("\n");
        return <Text key={key}>{out}</Text>;
      }
      const pad = v.paddingX ?? 0;
      let md = renderMarkdownStreaming(v, w - pad);
      if (md.replace(ANSI, "").trim() === "") return null;
      if (v.color) md = md.split("\n").map(v.color).join("\n");
      const indent = " ".repeat(pad);
      return <Text key={key}>{md.split("\n").map((l) => indent + l).join("\n")}</Text>;
    }
    case "spacer":
      return <Box key={key} height={v.rows} />;
    case "container": {
      const kids = v.children.map((c, i) => renderVNode(c, i)).filter((x) => x !== null);
      if (kids.length === 0) return null; // an empty block renders nothing, like pi-tui
      return <Box key={key} flexDirection="column">{kids}</Box>;
    }
    case "loader":
      return (
        <Box key={key}>
          <Text color={ACCENT_HEX}><Spinner type="dots" /></Text>
          <Text color={ACCENT_HEX}>{" " + v.label}</Text>
        </Box>
      );
    case "select": {
      // Drawn here; navigated by raw keys in the input dispatch (focus === "select").
      const s = v.state;
      const n = s.items.length;
      const rows = Math.max(1, s.visibleRows);
      const start = n > rows ? Math.max(0, Math.min(s.index - Math.floor(rows / 2), n - rows)) : 0;
      return (
        <Box key={key} flexDirection="column">
          {s.items.slice(start, start + rows).map((it, i) => {
            const active = start + i === s.index;
            return (
              <Text key={it.value} color={active ? ACCENT_HEX : undefined}>
                {(active ? "❯ " : "  ") + it.label}
              </Text>
            );
          })}
        </Box>
      );
    }
  }
}

// Renderer owns inter-block rhythm: one blank line above each block (marginTop),
// except index 0 and a tool result (cont → tight under its call). The shared chat
// controllers also prepend a per-block spacer, so drop a block's leading spacer here.
function renderBlock(child: VNode, globalIndex: number): React.ReactElement | null {
  const block: VNode = child.kind === "container" && child.children[0]?.kind === "spacer"
    ? { ...child, children: child.children.slice(1) }
    : child;
  const el = renderVNode(block, globalIndex);
  if (el === null) return null;
  const tight = block.kind === "text" && !!block.cont;
  const marginTop = globalIndex === 0 || tight ? 0 : 1;
  return <Box key={globalIndex} flexDirection="column" marginTop={marginTop}>{el}</Box>;
}

function cursorLineCol(editor: LineEditor): { line: number; col: number } {
  const t = editor.text;
  const idx = Math.min(editor.cursor, t.length);
  const before = t.slice(0, idx);
  return { line: before.split("\n").length - 1, col: idx - (before.lastIndexOf("\n") + 1) };
}

function paintInput(editor: LineEditor, focused: boolean): string {
  const text = editor.displayText;
  let body = text;
  if (focused) {
    const cur = editor.displayCursor;
    const at = text[cur];
    if (at === undefined) body = `${text}${CURSOR_ON} ${CURSOR_OFF}`;
    else if (at === "\n") body = `${text.slice(0, cur)}${CURSOR_ON} ${CURSOR_OFF}${text.slice(cur)}`;
    else body = `${text.slice(0, cur)}${CURSOR_ON}${at}${CURSOR_OFF}${text.slice(cur + 1)}`;
  }
  return body.split("\n").map((l, i) => (i === 0 ? USER_MARKER : "  ") + l).join("\n");
}

interface AppState {
  scrollback: VNode;
  footer: VNode;
  queue: VNode;
  status: VNode;
  belowInput: VNode;
  editor: LineEditor;
  onChange?: (t: string) => void;
  onSubmit?: (t: string) => void;
  focus: "input" | "select";
  activeSelect: SelectState | null;
  keyHandlers: KeyHandler[];
  // [0, committedCount) are settled and render via <Static>; the rest is the live turn.
  committedCount: number;
  borderColor: string;
}

// Global key matching shares pi-tui's matcher, so it behaves identically to the
// default renderer (kitty-aware once ProcessTerminal enables the protocol).
function buildKeyEvent(seq: string): KeyEvent {
  return {
    matches: (name) => matchesKey(seq, name as KeyId),
    isRelease: () => isKeyRelease(seq),
    isRepeat: () => isKeyRepeat(seq),
  };
}

function Root({ store, state }: { store: Store; state: AppState }): React.ReactElement {
  React.useSyncExternalStore(store.subscribe, store.get, store.get);
  // Settled turns flow into native scrollback via <Static> (written once); only the
  // live tail + chrome stay in Ink's managed region, so a chunk repaints one entry.
  const sb = state.scrollback;
  const sbChildren = sb.kind === "container" ? sb.children : [];
  const cc = Math.min(state.committedCount, sbChildren.length);
  const committed = sbChildren.slice(0, cc);
  const live = sbChildren.slice(cc);
  const tree = (
    <Box flexDirection="column">
      <Static items={committed}>
        {(child, i) => renderBlock(child, i)}
      </Static>
      {live.map((child, i) => renderBlock(child, cc + i))}
      {renderVNode(state.footer)}
      {renderVNode(state.queue)}
      <Box marginTop={1} borderStyle="single" borderLeft={false} borderRight={false} borderColor={state.borderColor}>
        <Text>{paintInput(state.editor, state.focus === "input")}</Text>
      </Box>
      {renderVNode(state.belowInput)}
      {renderVNode(state.status)}
    </Box>
  );
  return tree;
}

function containerView(v: VNode, req: () => void): ContainerView {
  const ch = v.kind === "container" ? v.children : [];
  return {
    node: asNode(v),
    addChild: (c) => { ch.push(asV(c)); req(); },
    removeChild: (c) => { const i = ch.indexOf(asV(c)); if (i >= 0) ch.splice(i, 1); req(); },
    clear: () => { ch.length = 0; req(); },
  };
}

function makeApp(store: Store, req: () => void): {
  app: App; element: React.ReactElement; dispatch: (seq: string) => void; editor: LineEditor;
} {
  const scrollback: VNode = { kind: "container", children: [] };
  const footer: VNode = { kind: "container", children: [] };
  const queue: VNode = { kind: "container", children: [] };
  const status: VNode = { kind: "text", lines: [], fn: null };
  const belowInput: VNode = { kind: "container", children: [] };
  const editor = new LineEditor();

  const state: AppState = {
    scrollback, footer, queue, status, belowInput, editor,
    focus: "input",
    activeSelect: null,
    keyHandlers: [],
    committedCount: 0,
    borderColor: MARKER_GRAY_HEX,
  };

  let ink: Instance | null = null;
  const element = <Root store={store} state={state} />;
  const terminal = new ProcessTerminal();

  // Multi-line buffer: ↑/↓ move between lines; at the top/bottom edge, page history.
  const moveVertical = (dir: number): boolean => {
    const lines = editor.text.split("\n");
    if (lines.length > 1) {
      let acc = 0, line = 0;
      for (; line < lines.length; line++) {
        if (editor.cursor <= acc + lines[line]!.length) break;
        acc += lines[line]!.length + 1;
      }
      const target = line + dir;
      if (target >= 0 && target < lines.length) {
        const col = editor.cursor - acc;
        let pos = 0;
        for (let i = 0; i < target; i++) pos += lines[i]!.length + 1;
        editor.cursor = pos + Math.min(col, lines[target]!.length);
        return true;
      }
    }
    return (dir < 0 ? editor.historyBack() : editor.historyForward()) !== null;
  };

  const handleSelectKey = (seq: string): void => {
    const s = state.activeSelect;
    if (!s) return;
    const n = s.items.length;
    if (matchesKey(seq, "escape")) { s.onCancel(); return; }
    if (n === 0) return;
    if (matchesKey(seq, "up")) { s.index = (s.index - 1 + n) % n; s.highlighted = s.items[s.index]; req(); }
    else if (matchesKey(seq, "down")) { s.index = (s.index + 1) % n; s.highlighted = s.items[s.index]; req(); }
    else if (matchesKey(seq, "enter") || matchesKey(seq, "return")) { const it = s.items[s.index]; if (it) s.onSelect(it); }
  };

  // One raw key sequence (pre-segmented + paste-rewrapped by ProcessTerminal). Global
  // handlers get first refusal, like pi-tui's input listeners; whatever they leave
  // drives the focused surface — the select picker or the line editor.
  const dispatch = (seq: string): void => {
    const ev = buildKeyEvent(seq);
    for (const h of state.keyHandlers) if (h(ev)?.consume) return;
    if (isKeyRelease(seq)) return;
    if (state.focus === "select") { handleSelectKey(seq); return; }
    const before = editor.text;
    let changed = false;
    let submitted: string | null = null;
    for (const a of editor.feed(seq)) {
      if (a.action === "submit") submitted = a.buffer;
      else if (a.action === "arrow-up") changed = moveVertical(-1) || changed;
      else if (a.action === "arrow-down") changed = moveVertical(1) || changed;
      else changed = true;
    }
    if (editor.text !== before) state.onChange?.(editor.text);
    if (submitted !== null) { editor.pushHistory(submitted); state.onSubmit?.(submitted); changed = true; }
    if (changed) req();
  };

  // <Static> entries are permanent, so clearing needs a true reset: unmount, wipe the
  // screen + scrollback buffer (\x1b[3J), remount. No-op before start() (headless).
  const resetTerminal = (): void => {
    if (!ink) return;
    ink.unmount();
    process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
    ink = inkRender(element);
  };
  const scrollbackChildren = scrollback.kind === "container" ? scrollback.children : [];
  const scrollbackView: ContainerView = {
    node: asNode(scrollback),
    addChild: (c) => { scrollbackChildren.push(asV(c)); req(); },
    removeChild: (c) => { const i = scrollbackChildren.indexOf(asV(c)); if (i >= 0) scrollbackChildren.splice(i, 1); req(); },
    clear: () => { scrollbackChildren.length = 0; state.committedCount = 0; resetTerminal(); req(); },
  };

  const statusView: TextView = {
    node: asNode(status),
    setText: (s) => { if (status.kind === "text") { status.lines = s.split("\n"); status.fn = null; } req(); },
    setLines: (l) => { if (status.kind === "text") { status.lines = l; status.fn = null; } req(); },
    setRenderFn: (fn) => { if (status.kind === "text") status.fn = fn; req(); },
  };

  const inputView: InputView = {
    node: asNode({ kind: "text", lines: [], fn: null }),
    getText: () => editor.text,
    setText: (t) => { editor.setText(t); req(); },
    getCursor: () => cursorLineCol(editor),
    replaceBeforeCursor: (count, text) => {
      const t = editor.text;
      const cur = Math.min(editor.cursor, t.length);
      const start = Math.max(0, cur - count);
      editor.setText(t.slice(0, start) + text + t.slice(cur));
      editor.cursor = start + text.length;
      req();
    },
    onChange: (fn) => { state.onChange = fn; },
    onSubmit: (fn) => { state.onSubmit = fn; },
    defaultBorderColor: (t) => `${MARKER_GRAY}${t}${RESET}`,
    setBorderColor: (fn) => { state.borderColor = hexFromStyler(fn); req(); },
    invalidate: () => req(),
  };

  const app: App = {
    scrollback: scrollbackView,
    footerSlot: containerView(footer, req),
    queueSlot: containerView(queue, req),
    input: inputView,
    belowInput: containerView(belowInput, req),
    status: statusView,
    setFocus: (target) => {
      const tv = asV(target);
      state.focus = tv.kind === "select" ? "select" : "input";
      state.activeSelect = tv.kind === "select" ? tv.state : null;
      req();
    },
    focusInput: () => { state.focus = "input"; state.activeSelect = null; req(); },
    requestRender: () => req(),
    commitScrollback: () => { state.committedCount = scrollbackChildren.length; req(); },
    start: () => {
      if (ink) return;
      // ProcessTerminal owns raw stdin and runs the kitty-keyboard handshake, so
      // Shift+Enter / Alt+B arrive as distinct sequences; it also drives our resize bump.
      terminal.start(dispatch, req);
      ink = inkRender(element);
    },
    stop: () => { terminal.stop(); ink?.unmount(); ink = null; },
    onKey: (handler) => { state.keyHandlers.push(handler); },
    createSelectList: (items, opts): SelectView => {
      const sel: SelectState = {
        items, index: items.length > 0 ? 0 : -1, visibleRows: opts.visibleRows,
        highlighted: items[0], onSelect: () => {}, onCancel: () => {},
      };
      const v: VNode = { kind: "select", state: sel };
      return {
        node: asNode(v),
        setSelectedIndex: (i) => { sel.index = i; sel.highlighted = sel.items[i]; req(); },
        getSelectedItem: () => sel.highlighted ?? sel.items[sel.index],
        onSelect: (fn) => { sel.onSelect = fn; },
        onCancel: (fn) => { sel.onCancel = fn; },
      };
    },
    createLoader: (label): LoaderView => {
      const v: VNode = { kind: "loader", label };
      return { node: asNode(v), stop: () => {} };
    },
  };
  return { app, element, dispatch, editor };
}

interface InkHarness {
  nodes: RenderNodes;
  mountToolCall: Renderer["mountToolCall"];
  app: App;
  element: React.ReactElement;
  feedInput: (seq: string) => void;
  editor: LineEditor;
}

function buildRenderer(): { renderer: Renderer; harness: () => InkHarness } {
  const store = createStore();
  const req = (): void => store.bump();
  const blink = makeBlink(req);
  const nodes = makeNodes(req);
  const tool = makeToolMount(req, blink);
  const mountToolCall: Renderer["mountToolCall"] = (model, args, env) => tool.mountCall(model, args, env);
  const renderer: Renderer = {
    ...nodes,
    capabilities: { images: false, markdownStreaming: true, diffFrame: false },
    measureWidth,
    mountToolCall,
    mountToolResult: (model, args, env) => tool.mountResult(model, args, env),
    mountToolGroup: () => makeToolGroup(req, blink),
    mount: () => makeApp(store, req).app,
  };
  const harness = (): InkHarness => {
    const built = makeApp(store, req);
    return { nodes, mountToolCall, app: built.app, element: built.element, feedInput: built.dispatch, editor: built.editor };
  };
  return { renderer, harness };
}

export function createInkRenderer(): Renderer {
  return buildRenderer().renderer;
}

/** Test helper: render one RenderNode tree to a frame. */
export function __renderNode(node: RenderNode): React.ReactElement | null {
  return renderVNode(asV(node));
}

/** Test helper: renderer + a built App/Root, for headless full-stack layout tests. */
export function __harness(): InkHarness {
  return buildRenderer().harness();
}
