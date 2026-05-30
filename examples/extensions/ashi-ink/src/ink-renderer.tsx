// Bridges ashi's imperative node model to Ink's declarative tree via mutable
// vnodes + a version store that forces re-render. Degradations are in the README.

import React from "react";
import { Box, Text, useInput, render as inkRender, type Instance } from "ink";
import TextInput from "ink-text-input";
import SelectInput from "ink-select-input";
import Spinner from "ink-spinner";
import { Marked } from "marked";
import { markedTerminal } from "marked-terminal";
import {
  iconString,
  renderBody,
  segmentsToString,
  statusSuffix,
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
  ToolResultView,
} from "@guanyilun/ashi/renderer";

interface SelectState {
  items: SelectItem[];
  index: number;
  highlighted?: SelectItem;
  onSelect: (item: SelectItem) => void;
  onCancel: () => void;
}

type VNode =
  | { kind: "text"; lines: string[]; fn: ((width: number) => string[]) | null; paddingX?: number }
  | { kind: "markdown"; source: string; color?: (t: string) => string; userMsg?: boolean; paddingX?: number }
  | { kind: "spacer"; rows: number }
  | { kind: "container"; children: VNode[] }
  | { kind: "loader"; label: string }
  | { kind: "select"; state: SelectState };

const asNode = (v: VNode): RenderNode => v as unknown as RenderNode;
const asV = (n: RenderNode): VNode => n as unknown as VNode;

const ANSI = /\x1b\[[0-9;]*m/g;
const measureWidth = (text: string): number => text.replace(ANSI, "").length;
const termWidth = (): number => process.stdout.columns ?? 80;

// Ink's signature accent: a soft violet (#c778dd), used for the prompt, the
// tool gutter, user-turn markers, and the loader.
const ACCENT = "\x1b[38;2;199;120;221m";
const ACCENT_HEX = "#c778dd";
const RESET = "\x1b[39m";
const BOLD = "\x1b[1m";
const BOLD_OFF = "\x1b[22m";
const USER_BG = "#2b2b30"; // faint gray band behind a sent user turn (Claude Code style)
const USER_MARKER = `${ACCENT}${BOLD}❯${BOLD_OFF}${RESET} `; // fg-only codes, safe inside the band

// marked-terminal defaults to width 80 / no reflow, so prose never wraps to the
// real terminal width. Reflow at the available width (cached per width) so the
// caller can indent each wrapped line consistently.
const markedCache = new Map<number, Marked>();
function markedFor(width: number): Marked {
  let m = markedCache.get(width);
  if (!m) {
    m = new Marked();
    m.use(markedTerminal({ width, reflowText: true }) as Parameters<Marked["use"]>[0]);
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

interface Store {
  bump: () => void;
  subscribe: (l: () => void) => () => void;
  get: () => number;
}
function createStore(): Store {
  let version = 0;
  const listeners = new Set<() => void>();
  return {
    bump: () => { version++; for (const l of listeners) l(); },
    subscribe: (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
    get: () => version,
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
      const v: VNode = { kind: "markdown", source: "", color: opts?.color, userMsg: opts?.osc133Zones, paddingX: opts?.paddingX };
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

// A solid gutter channels each tool call/result, instead of pi-tui's gray
// corner-arrow. Errors turn the gutter red.
const OK_GUTTER = `${ACCENT}▌${RESET} `;
const ERR_GUTTER = `\x1b[38;2;224;108;117m▌${RESET} `;
const GUTTER_W = 2;

interface Cell {
  state: ViewState<Record<string, unknown>>;
  env: Env;
  diff: DiffSlot;
  model: RenderModel<unknown>;
}

function gutterFor(display: ToolDisplay): string {
  const ok = display.status?.exitCode === null || display.status?.exitCode === 0;
  return ok ? OK_GUTTER : ERR_GUTTER;
}

function paintCall(cell: Cell, width: number): string {
  const display = cell.model.view(cell.state, cell.env) as ToolDisplay;
  const icon = iconString(display.titleIcon);
  const title = segmentsToString(display.title);
  const status = statusSuffix(display.status);
  if (display.titleRight && display.titleRight.length > 0) {
    const right = segmentsToString(display.titleRight);
    const used = measureWidth(icon) + measureWidth(title) + measureWidth(status) + measureWidth(right);
    const pad = " ".repeat(Math.max(2, width - GUTTER_W - 2 - used));
    return `${gutterFor(display)}${icon}${title}${status}${pad}${right}`;
  }
  return `${gutterFor(display)}${icon}${title}${status}`;
}

function paintResult(cell: Cell, width: number): string[] {
  const env = { ...cell.env, width };
  const display = cell.model.view(cell.state, env) as ToolDisplay;
  if (!display.body) return [];
  if (display.body.kind === "diff" && !env.expanded && env.mode !== "preview") return [];
  const policied = display.body.kind === "stream" || display.body.kind === "diff";
  if (!policied && !env.expanded && !display.defaultExpanded) return [];
  const bodyEnv: Env = { ...env, width: Math.max(1, width - GUTTER_W) };
  const rendered = renderBody(display.body, bodyEnv, cell.diff);
  if (!rendered.trim()) return [];
  const gutter = gutterFor(display);
  return rendered.split("\n").map((l) => `${gutter}${l}`);
}

function makeToolMount(req: () => void) {
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
    };
    handles.set(args.toolCallId, cell);
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
      const v: VNode = { kind: "text", lines: [], fn: (w) => [paintCall(cell, w)] };
      return { node: asNode(v), setStatus: (o) => dispatch(cell, "status", o) };
    },
    mountResult(model: RenderModel<unknown>, args: MountArgs, env: MountEnv): ToolResultView {
      const cell = cellFor(model, args, env);
      const v: VNode = { kind: "text", lines: [], fn: (w) => paintResult(cell, w) };
      return {
        node: asNode(v),
        appendChunk: (c) => dispatch(cell, "chunk", c),
        setDiffRenderer: (fn) => dispatch(cell, "diff", fn),
        finalize: (o) => { cell.env = { ...cell.env, finalized: true }; dispatch(cell, "status", { ...o, elapsedMs: 0 }); handles.delete(args.toolCallId); },
        toggleExpanded: () => { cell.env = { ...cell.env, expanded: !cell.env.expanded }; req(); },
      };
    },
  };
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
        // A sent user turn: a faint full-width band with a violet ❯ marker (the
        // input prompt). Ink's <Text backgroundColor> colors padding too, so
        // padding each line to the terminal width fills the row. marked-terminal
        // emits \x1b[0m full resets that would reset the background mid-line, so
        // strip ANSI — a user turn is plain text on the band; only the fg-only
        // marker codes (safe over a background) are added back.
        const plain = renderMarkdown(v.source, w - 2).replace(ANSI, "");
        const banded = plain.split("\n").map((l, i) => {
          const marker = i === 0 ? USER_MARKER : "  ";
          return marker + l + " ".repeat(Math.max(0, w - 2 - l.length));
        }).join("\n");
        return <Text key={key} backgroundColor={USER_BG}>{banded}</Text>;
      }
      const pad = v.paddingX ?? 0;
      let md = renderMarkdown(v.source, w - pad);
      if (md.replace(ANSI, "").trim() === "") return null;
      if (v.color) md = md.split("\n").map(v.color).join("\n");
      const indent = " ".repeat(pad);
      return <Text key={key}>{md.split("\n").map((l) => indent + l).join("\n")}</Text>;
    }
    case "spacer":
      return <Box key={key} height={v.rows} />;
    case "container":
      return (
        <Box key={key} flexDirection="column">
          {v.children.map((c, i) => renderVNode(c, i))}
        </Box>
      );
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

interface AppState {
  scrollback: VNode;
  footer: VNode;
  queue: VNode;
  status: VNode;
  input: { text: string; onChange?: (t: string) => void; onSubmit?: (t: string) => void };
  focus: "input" | "select";
  keyHandlers: KeyHandler[];
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
  useInput((input, key) => {
    const ev = buildKeyEvent(input, key as unknown as Record<string, boolean>);
    for (const h of state.keyHandlers) {
      const r = h(ev);
      if (r && r.consume) break;
    }
  });
  return (
    <Box flexDirection="column">
      {renderVNode(state.scrollback)}
      {renderVNode(state.footer)}
      {renderVNode(state.queue)}
      <Box
        borderStyle="single"
        borderLeft={false}
        borderRight={false}
        borderColor={state.focus === "input" ? ACCENT_HEX : "gray"}
        paddingX={1}
      >
        <Text color={ACCENT_HEX} bold>{"❯ "}</Text>
        <TextInput
          value={state.input.text}
          focus={state.focus === "input"}
          showCursor={state.focus === "input"}
          onChange={(val) => { state.input.text = val; state.input.onChange?.(val); store.bump(); }}
          onSubmit={(val) => { state.input.onSubmit?.(val); }}
        />
      </Box>
      {renderVNode(state.status)}
    </Box>
  );
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
  };

  let ink: Instance | null = null;
  const element = <Root store={store} state={state} />;

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
    scrollback: containerView(scrollback, req),
    footerSlot: containerView(footer, req),
    queueSlot: containerView(queue, req),
    input: inputView,
    status: statusView,
    setFocus: (target) => { state.focus = asV(target).kind === "select" ? "select" : "input"; req(); },
    focusInput: () => { state.focus = "input"; req(); },
    requestRender: () => req(),
    start: () => { if (!ink) ink = inkRender(element); },
    stop: () => { ink?.unmount(); ink = null; },
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
  const nodes = makeNodes(req);
  const tool = makeToolMount(req);
  const mountToolCall: Renderer["mountToolCall"] = (model, args, env) => tool.mountCall(model, args, env);
  const renderer: Renderer = {
    ...nodes,
    capabilities: { images: false, markdownStreaming: true },
    measureWidth,
    mountToolCall,
    mountToolResult: (model, args, env) => tool.mountResult(model, args, env),
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
