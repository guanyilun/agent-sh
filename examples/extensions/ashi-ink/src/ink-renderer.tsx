// Bridges ashi's imperative node model to Ink's declarative tree via mutable
// vnodes + a version store that forces re-render. Degradations are in the README.

import React from "react";
import { Box, Static, Text, useInput, render as inkRender, type Instance } from "ink";
import TextInput from "ink-text-input";
import SelectInput from "ink-select-input";
import Spinner from "ink-spinner";
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
  AutocompleteProvider,
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
import { INSPECT_FILE, inspectBump, inspectConsole, inspectReentrantBump, makeCommitWatcher } from "./inspect.js";

const commitWatcher = INSPECT_FILE ? makeCommitWatcher() : null;

interface SelectState {
  items: SelectItem[];
  index: number;
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

// Ink's accent violet (#c778dd), used for the loader spinner and the focused
// input border. Chat markers are neutral gray (see MARKER_GRAY) — Claude Code style.
const ACCENT_HEX = "#c778dd";
const RESET = "\x1b[39m";
const BOLD = "\x1b[1m";
const BOLD_OFF = "\x1b[22m";
const USER_BG = "#3a3a42"; // subtle gray band behind a sent user turn (Claude Code style)
const MARKER_GRAY = "\x1b[38;2;154;160;166m"; // light-gray ❯ (raw ANSI, safe over the band bg)
const MARKER_GRAY_HEX = "#9aa0a6"; // same gray for Ink color props (the input prompt)
const USER_MARKER = `${MARKER_GRAY}${BOLD}❯${BOLD_OFF}${RESET} `; // ❯ at col 0, 2-col gutter
const ASSISTANT_MARKER = "⏺ "; // assistant response bullet (Claude Code), default fg, 2-col gutter

// Claude Code's dark-theme status colors for the tool dot — its success green and
// error red, which differ from ashi's theme palette (ink mimics Claude Code's look).
const DOT_OK = "\x1b[38;2;78;186;101m"; // rgb(78,186,101) bright green
const DOT_ERR = "\x1b[38;2;255;107;128m"; // rgb(255,107,128) bright red
const DIM_ON = "\x1b[2m"; // running dot is dimmed default-fg, like Claude Code's dimColor
const DIM_OFF = "\x1b[22m";

// marked-terminal's legacy table renderer hands us pre-rendered header/body
// strings delimited by these markers, then sizes the table to content with no
// max — so a wide column overflows the terminal and Ink re-wraps it to chaos.
// We split the markers ourselves and rebuild with cli-table3 colWidths that fit
// the available width (the one constraint that makes it wrap inside cells).
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
  // Grow eagerly to the content's natural width; only shrink+wrap once the table
  // would exceed the terminal. (cli-table3 otherwise spans the full width always.)
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

// marked-terminal defaults to width 80 / no reflow, so prose never wraps to the
// real terminal width. Reflow at the available width (cached per width) so the
// caller can indent each wrapped line consistently; override the table renderer
// to fit the terminal (see fitTable).
const markedCache = new Map<number, Marked>();
function markedFor(width: number): Marked {
  let m = markedCache.get(width);
  if (!m) {
    m = new Marked();
    // tab: list / code-block / blockquote indent. 0 = flush-left markdown (the
    // bullet gutter is the only indent); flattens nested lists, which is accepted.
    m.use(markedTerminal({ width, reflowText: true, tab: 0 }) as Parameters<Marked["use"]>[0]);
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

// Stable-prefix streaming (the Claude Code pattern): re-parsing the whole reply
// every frame is O(n²) over a long stream. Lex only the unstable tail, treat the
// last non-space token as the still-growing block, and cache the rendered output
// of the completed blocks (the boundary only advances). marked's lexer keeps an
// unclosed code fence as one token, so the boundary never splits mid-block —
// render(stable) + "\n\n" + render(unstable) === render(whole) for marked-terminal.
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
  let flushing = false;
  const listeners = new Set<() => void>();
  // Coalesce bumps to one notification per tick. Streaming fires req() many times
  // a tick (chunk text + status + loader); a synchronous bump on each one advances
  // the snapshot under useSyncExternalStore's post-commit re-check, which force-
  // re-renders, re-checks, and runs away ("Maximum update depth"). Deferring to a
  // microtask collapses a burst into a single render whose snapshot is stable at
  // commit, so the re-check matches and the loop never forms.
  let lastFlush = 0;
  const flush = (): void => {
    scheduled = false;
    lastFlush = performance.now();
    version++;
    flushing = true;
    for (const l of [...listeners]) l();
    flushing = false;
  };
  return {
    // Throttle to ~60fps via a timer (a macrotask). A fast stream emits chunk
    // events microtask-paced; coalescing per-microtask still flushes once per
    // chunk, and those flushes chain within one macrotask drain until React's
    // nested-update limit trips ("Maximum update depth"). A timer flush runs at
    // the macrotask boundary, so a whole burst collapses into one render and the
    // chain can't form.
    bump: () => {
      if (INSPECT_FILE) { inspectBump(); if (flushing) inspectReentrantBump(); }
      if (scheduled) return;
      scheduled = true;
      const h = setTimeout(flush, Math.max(0, 16 - (performance.now() - lastFlush)));
      (h as { unref?: () => void }).unref?.();
    },
    subscribe: (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
    get: () => version,
  };
}

// Claude Code blinks a running tool's dot — a dimmed ⏺ toggling on/off every
// ~600ms — and shows it solid (green ok / red error) once resolved. One shared
// clock keeps every running dot in sync; it ticks only while something is running
// and unrefs so it never holds the process open (headless tests still exit clean).
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
      // osc133Zones is only set for user turns; use it to give them the band.
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

// Claude Code tool look (ink owns the presentation; the schema supplies only the
// data — name/detail/status/body). A tool call is `⏺ Name(detail)`, the ⏺ dimmed
// and blinking while running, then solid green ok / red error; the result hangs
// under a `⎿` gutter (⎿ at col 2, content at col 5), matching the ⏺ bullet rhythm.
const RESULT_GUTTER = "     "; // 5 cols — continuation under "  ⎿  "

function prettyToolName(name: string): string {
  const base = (name || "tool").replace(/_file$/i, "").replace(/[_-]+/g, " ").trim();
  const words = base.split(" ").filter(Boolean).map((w) => w[0]!.toUpperCase() + w.slice(1));
  return words.join(" ") || "Tool";
}

// The status dot, Claude Code style: a dimmed ⏺ that blinks (a blank when the
// shared clock is off) while running, solid green/red once resolved. A blank keeps
// the 2-col gutter so the name never shifts as the dot blinks.
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
  return detail ? `${bullet} ${nameStyled}(${detail})${tail}` : `${bullet} ${nameStyled}${tail}`;
}

function paintResult(cell: Cell, width: number): string[] {
  const env = { ...cell.env, width };
  const display = cell.model.view(cell.state, env) as ToolDisplay;
  if (!display.body) return [];
  if (display.body.kind === "diff" && !env.expanded && env.mode !== "preview") return [];
  const policied = display.body.kind === "stream" || display.body.kind === "diff";
  if (!policied && !env.expanded && !display.defaultExpanded) return [];
  const bodyEnv: Env = { ...env, width: Math.max(1, width - RESULT_GUTTER.length) };
  const rendered = renderBody(display.body, bodyEnv, cell.diff);
  if (!rendered.trim()) return [];
  const ok = display.status?.exitCode === null || display.status?.exitCode === 0;
  const elbow = segmentsToString([{ text: "⎿", style: { color: ok ? "muted" : "error" } }]);
  const lines = rendered.split("\n");
  lines[0] = `  ${elbow}  ${lines[0]}`;
  for (let i = 1; i < lines.length; i++) lines[i] = `${RESULT_GUTTER}${lines[i]}`;
  return lines;
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

// A read/search group, Claude Code style: a single `⏺ Read N files` summary line
// (not a ├/└ tree, no "+N earlier" eviction). Expanding (Ctrl+O) lists each call
// under a `⎿` gutter. The whole count is summarized whether or not the substrate
// evicted older calls — ink reads the model and draws it however it likes.
function summarizeGroup(kind: string, n: number): string {
  if (kind === "read") return `Read ${n} file${n === 1 ? "" : "s"}`;
  if (kind === "search") return `Searched ${n} pattern${n === 1 ? "" : "s"}`;
  return `${n} ${kind} call${n === 1 ? "" : "s"}`;
}
function childOk(c: ToolGroupModel["children"][number]): boolean {
  return !c.status || c.status.exitCode === null || c.status.exitCode === 0;
}
function groupSummaryLine(model: ToolGroupModel, blinkOn: boolean): string {
  const total = model.children.length + (model.hidden?.count ?? 0);
  const running = model.children.some((c) => !c.status);
  const anyErr = model.children.some((c) => !childOk(c)) || (model.hidden ? !model.hidden.ok : false);
  const dot = statusDot(running ? undefined : { exitCode: anyErr ? 1 : 0 }, blinkOn);
  return `${dot} ${summarizeGroup(model.kind, total)}`;
}
function makeToolGroup(req: () => void, blink: Blink): ToolGroupView {
  const v: VNode = { kind: "container", children: [] };
  const ch = v.kind === "container" ? v.children : [];
  let model: ToolGroupModel | null = null;
  let acquired = false;
  const update = (m: ToolGroupModel): void => {
    model = m;
    const running = m.children.some((c) => !c.status);
    if (running && !acquired) { blink.start(v); acquired = true; }
    else if (!running && acquired) { blink.stop(v); acquired = false; }
    ch.length = 0;
    // Summary bullet via a render fn so the blink clock repaints it in place.
    ch.push({ kind: "text", lines: [], fn: () => (model ? [groupSummaryLine(model, blink.on())] : []), paddingX: 0 });
    if (m.expanded) {
      for (const c of m.children) {
        const elbow = segmentsToString([{ text: "⎿", style: { color: childOk(c) ? "muted" : "error" } }]);
        const sum = c.status?.summary ? ` ${segmentsToString([{ text: c.status.summary, style: { color: "muted" } }])}` : "";
        ch.push({ kind: "text", lines: [`  ${elbow}  ${c.detail}${sum}`], fn: null, paddingX: 0 });
      }
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
        // A sent user turn: a faint full-width band with a ❯ marker at column 0
        // (Claude Code style). Ink's <Text backgroundColor> colors padding too, so
        // padding each line to the terminal width fills the row. marked-terminal
        // emits \x1b[0m full resets that would reset the background mid-line, so
        // strip ANSI — a user turn is plain text on the band; only the fg-only
        // marker codes (safe over a background) are added back. 2-col gutter
        // ("❯ " / "  ") so wrapped lines align with the content.
        const plain = renderMarkdown(v.source, w - 2).replace(ANSI, "");
        const banded = plain.split("\n").map((l, i) => {
          const marker = i === 0 ? USER_MARKER : "  ";
          return marker + l + " ".repeat(Math.max(0, w - 2 - l.length));
        }).join("\n");
        return <Text key={key} backgroundColor={USER_BG}>{banded}</Text>;
      }
      if (v.bullet) {
        // An assistant response: a ⏺ bullet at column 0, content hanging-indented
        // to column 2 (Claude Code design). No background, no extra padding.
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
      const s = v.state;
      const items = s.items.map((it) => ({ label: it.label, value: it.value }));
      return (
        <SelectInput
          key={key}
          items={items}
          initialIndex={Math.min(s.index, Math.max(0, items.length - 1))}
          onHighlight={(it) => { s.highlighted = s.items.find((x) => x.value === it.value); }}
          onSelect={(it) => { const found = s.items.find((x) => x.value === it.value); if (found) s.onSelect(found); }}
        />
      );
    }
  }
}

// The renderer owns inter-block rhythm (Claude Code's marginTop model): one blank
// line above each top-level scrollback block, except the very first and except a
// tool result, which stays tight under its call (the call vnode is the block start;
// the result carries `cont`). Empty blocks render nothing and so contribute no gap.
//
// The shared chat controllers also prepend a spacer per block (pi-tui's per-block
// gap); keeping it here would stack with marginTop and double the gap. So this
// renderer drops a block's leading spacer and lets marginTop be the single source.
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

interface AppState {
  scrollback: VNode;
  footer: VNode;
  queue: VNode;
  status: VNode;
  input: { text: string; onChange?: (t: string) => void; onSubmit?: (t: string) => void };
  focus: "input" | "select";
  keyHandlers: KeyHandler[];
  // Scrollback entries [0, committedCount) are settled; they render through
  // <Static> into native scrollback. The rest (the current turn) stay in Ink's
  // managed region, so they remain interactive (expand/toggle/group-merge) and
  // the live tail repaints alone.
  committedCount: number;
}

function buildKeyEvent(input: string, key: Record<string, boolean>): KeyEvent {
  const matches = (name: string): boolean => {
    const parts = name.split("+");
    const mods = parts.slice(0, -1);
    const base = parts[parts.length - 1]!;
    if (mods.includes("ctrl") && !key.ctrl) return false;
    if (mods.includes("shift") && !key.shift) return false;
    switch (base) {
      case "escape": return !!key.escape;
      case "up": return !!key.upArrow;
      case "down": return !!key.downArrow;
      case "tab": return !!key.tab;
      case "backspace": return !!key.backspace || !!key.delete;
      case "return": return !!key.return;
      default: return input === base;
    }
  };
  return { matches, isRelease: () => false, isRepeat: () => false };
}

function Root({ store, state }: { store: Store; state: AppState }): React.ReactElement {
  React.useSyncExternalStore(store.subscribe, store.get, store.get);
  // Stable handlers. Ink's useInput re-subscribes its stdin listener whenever the
  // handler identity changes, and ink-text-input re-runs on new callbacks — a
  // fresh closure every render churns those through the streaming render-storm
  // (the "dependency changes every render" loop). state/store are stable refs.
  const onKey = React.useCallback((input: string, key: Record<string, unknown>) => {
    const ev = buildKeyEvent(input, key as Record<string, boolean>);
    for (const h of state.keyHandlers) { const r = h(ev); if (r && r.consume) break; }
  }, [state]);
  const onChange = React.useCallback((val: string) => {
    state.input.text = val; state.input.onChange?.(val); store.bump();
  }, [state, store]);
  const onSubmit = React.useCallback((val: string) => { state.input.onSubmit?.(val); }, [state]);
  useInput(onKey as Parameters<typeof useInput>[0]);
  // Settled scrollback flows into the terminal's native scrollback via <Static>
  // (written once, never repainted), exactly like pi-tui pushing committed lines
  // above its viewport. Only the live tail + chrome stay in Ink's managed region,
  // so a streaming chunk repaints one entry instead of the whole growing tree.
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
      <Box
        marginTop={1}
        borderStyle="single"
        borderLeft={false}
        borderRight={false}
        borderColor={state.focus === "input" ? ACCENT_HEX : "gray"}
      >
        <Text color={MARKER_GRAY_HEX} bold>{"❯ "}</Text>
        <TextInput
          value={state.input.text}
          focus={state.focus === "input"}
          showCursor={state.focus === "input"}
          onChange={onChange}
          onSubmit={onSubmit}
        />
      </Box>
      {renderVNode(state.status)}
    </Box>
  );
  return commitWatcher
    ? <React.Profiler id="ashi" onRender={commitWatcher}>{tree}</React.Profiler>
    : tree;
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

function makeApp(store: Store, req: () => void): { app: App; element: React.ReactElement } {
  const scrollback: VNode = { kind: "container", children: [] };
  const footer: VNode = { kind: "container", children: [] };
  const queue: VNode = { kind: "container", children: [] };
  const status: VNode = { kind: "text", lines: [], fn: null };

  const state: AppState = {
    scrollback, footer, queue, status,
    input: { text: "" },
    focus: "input",
    keyHandlers: [],
    committedCount: 0,
  };

  let ink: Instance | null = null;
  const element = <Root store={store} state={state} />;

  // <Static> writes committed entries permanently into native scrollback; Ink
  // can't un-write them. So clearing the chat (fork / session switch / rebuild)
  // needs a true reset: unmount, wipe the screen AND scrollback buffer (\x1b[3J),
  // then remount fresh. (No-op before start(), e.g. in headless tests.)
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
    getText: () => state.input.text,
    setText: (t) => { state.input.text = t; req(); },
    onChange: (fn) => { state.input.onChange = fn; },
    onSubmit: (fn) => { state.input.onSubmit = fn; },
    setAutocompleteProvider: (_p: AutocompleteProvider) => {},
    defaultBorderColor: (t) => t,
    setBorderColor: () => {},
    invalidate: () => req(),
  };

  const app: App = {
    scrollback: scrollbackView,
    footerSlot: containerView(footer, req),
    queueSlot: containerView(queue, req),
    input: inputView,
    status: statusView,
    setFocus: (target) => { state.focus = asV(target).kind === "select" ? "select" : "input"; req(); },
    focusInput: () => { state.focus = "input"; req(); },
    requestRender: () => req(),
    commitScrollback: () => { state.committedCount = scrollbackChildren.length; req(); },
    // Ink's own resize handler only re-layouts boxes and re-paints the existing
    // tree — it doesn't re-run Root, so width-dependent content (band, tables,
    // markdown reflow, status, tool output) wouldn't recompute. Bump the store
    // on resize to force a render at the new width.
    start: () => {
      if (ink) return;
      if (INSPECT_FILE) inspectConsole();
      process.stdout.on("resize", req);
      // Inspecting needs React's warning to reach our console wrapper, not Ink's
      // log interceptor — so disable patchConsole only then.
      ink = inkRender(element, INSPECT_FILE ? { patchConsole: false } : undefined);
    },
    stop: () => { process.stdout.off("resize", req); ink?.unmount(); ink = null; },
    onKey: (handler) => { state.keyHandlers.push(handler); },
    createSelectList: (items): SelectView => {
      const sel: SelectState = {
        items, index: Math.min(0, items.length - 1),
        onSelect: () => {}, onCancel: () => {},
      };
      const v: VNode = { kind: "select", state: sel };
      return {
        node: asNode(v),
        setSelectedIndex: (i) => { sel.index = i; req(); },
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
  return { app, element };
}

interface InkHarness {
  nodes: RenderNodes;
  mountToolCall: Renderer["mountToolCall"];
  app: App;
  element: React.ReactElement;
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
    capabilities: { images: false, markdownStreaming: true },
    measureWidth,
    mountToolCall,
    mountToolResult: (model, args, env) => tool.mountResult(model, args, env),
    mountToolGroup: () => makeToolGroup(req, blink),
    mount: () => makeApp(store, req).app,
  };
  const harness = (): InkHarness => {
    const built = makeApp(store, req);
    return { nodes, mountToolCall, app: built.app, element: built.element };
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
