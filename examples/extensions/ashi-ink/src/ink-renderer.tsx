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
  | { kind: "text"; lines: string[]; fn: ((width: number) => string[]) | null }
  | { kind: "markdown"; source: string; color?: (t: string) => string }
  | { kind: "spacer"; rows: number }
  | { kind: "container"; children: VNode[] }
  | { kind: "loader"; label: string }
  | { kind: "select"; state: SelectState };

const asNode = (v: VNode): RenderNode => v as unknown as RenderNode;
const asV = (n: RenderNode): VNode => n as unknown as VNode;

const ANSI = /\x1b\[[0-9;]*m/g;
const measureWidth = (text: string): number => text.replace(ANSI, "").length;
const termWidth = (): number => process.stdout.columns ?? 80;

const marked = new Marked();
marked.use(markedTerminal() as Parameters<typeof marked.use>[0]);
function renderMarkdown(src: string): string {
  try {
    return String(marked.parse(src)).replace(/\n+$/, "");
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
    text(): TextView {
      const v: VNode = { kind: "text", lines: [], fn: null };
      return {
        node: asNode(v),
        setText: (s) => { if (v.kind === "text") { v.lines = s.split("\n"); v.fn = null; } req(); },
        setLines: (lines) => { if (v.kind === "text") { v.lines = lines; v.fn = null; } req(); },
        setRenderFn: (fn) => { if (v.kind === "text") v.fn = fn; req(); },
      };
    },
    markdown(opts?: MarkdownOptions): MarkdownView {
      const v: VNode = { kind: "markdown", source: "", color: opts?.color };
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

const MUTED_ARROW = "\x1b[38;2;128;128;128m└\x1b[39m";
const ERROR_ARROW = "\x1b[38;2;204;102;102m└\x1b[39m";

interface Cell {
  state: ViewState<Record<string, unknown>>;
  env: Env;
  diff: DiffSlot;
  model: RenderModel<unknown>;
}

function paintCall(cell: Cell, width: number): string {
  const display = cell.model.view(cell.state, cell.env) as ToolDisplay;
  const icon = iconString(display.titleIcon);
  const title = segmentsToString(display.title);
  const status = statusSuffix(display.status);
  if (display.titleRight && display.titleRight.length > 0) {
    const right = segmentsToString(display.titleRight);
    const used = measureWidth(icon) + measureWidth(title) + measureWidth(status) + measureWidth(right);
    const pad = " ".repeat(Math.max(2, width - 2 - used));
    return `${icon}${title}${status}${pad}${right}`;
  }
  return `${icon}${title}${status}`;
}

function paintResult(cell: Cell, width: number): string[] {
  const env = { ...cell.env, width };
  const display = cell.model.view(cell.state, env) as ToolDisplay;
  if (!display.body) return [];
  if (display.body.kind === "diff" && !env.expanded && env.mode !== "preview") return [];
  const policied = display.body.kind === "stream" || display.body.kind === "diff";
  if (!policied && !env.expanded && !display.defaultExpanded) return [];
  const indent = "   ";
  const bodyEnv: Env = { ...env, width: Math.max(1, width - indent.length) };
  const rendered = renderBody(display.body, bodyEnv, cell.diff);
  if (!rendered.trim()) return [];
  const ok = display.status?.exitCode === null || display.status?.exitCode === 0;
  const arrow = ok ? MUTED_ARROW : ERROR_ARROW;
  const lines = rendered.split("\n");
  lines[0] = ` ${arrow} ${lines[0]}`;
  for (let i = 1; i < lines.length; i++) lines[i] = `${indent}${lines[i]}`;
  return lines;
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

export function renderVNode(v: VNode, key?: React.Key): React.ReactElement {
  switch (v.kind) {
    case "text": {
      const lines = v.fn ? v.fn(termWidth()) : v.lines;
      return <Text key={key}>{lines.join("\n")}</Text>;
    }
    case "markdown": {
      let md = renderMarkdown(v.source);
      if (v.color) md = md.split("\n").map(v.color).join("\n");
      return <Text key={key}>{md}</Text>;
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
          <Text color="cyan"><Spinner type="dots" /></Text>
          <Text>{" " + v.label}</Text>
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
      <Box>
        <Text color="gray">{state.focus === "input" ? "› " : "  "}</Text>
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
export function __renderNode(node: RenderNode): React.ReactElement {
  return renderVNode(asV(node));
}

/** Test helper: renderer + a built App/Root, for headless full-stack layout tests. */
export function __harness(): InkHarness {
  return buildRenderer().harness();
}
