import { Container, Spacer, Text, visibleWidth } from "@earendil-works/pi-tui";
import { theme } from "../../theme.js";
import type { RenderNode, ToolCallView, ToolResultView } from "../../renderer.js";
import {
  iconString,
  renderBody,
  segmentsToString,
  statusSuffix,
  type DiffSlot,
  type DisplayStatus,
  type Env,
  type MountArgs,
  type MountEnv,
  type Reducer,
  type RenderModel,
  type ViewState,
} from "../../schema.js";

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

const HANDLES = new Map<string, RenderHandle<unknown>>();

function handleFor<S>(
  args: MountArgs,
  model: RenderModel<S>,
  envInit: MountEnv,
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

  // Shared env guard: whichever sibling renders first observes the width change,
  // so it must re-layout both halves.
  override render(width: number): string[] {
    if (this.handle.cell.env.width !== width) {
      this.handle.cell.env = { ...this.handle.cell.env, width };
      this.repaint();
      this.handle.cell.resultView?.repaint();
    }
    return super.render(width);
  }

  repaint(): void {
    const display = this.handle.model.view(this.handle.cell.state as ViewState<unknown>, this.handle.cell.env);
    const icon = iconString(display.titleIcon);
    const title = segmentsToString(display.title);
    const status = statusSuffix(display.status);
    if (display.titleRight && display.titleRight.length > 0) {
      const right = segmentsToString(display.titleRight);
      // width − 2: Text has paddingX=1 each side.
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
      this.handle.cell.callView?.repaint();
    }
    return super.render(width);
  }

  repaint(): void {
    const env = this.handle.cell.env;
    const display = this.handle.model.view(this.handle.cell.state as ViewState<unknown>, env);
    if (!display.body) { this.body.setText(""); return; }
    if (display.body.kind === "diff" && !env.expanded && env.mode !== "preview") {
      this.body.setText("");
      return;
    }
    const policied = display.body.kind === "stream" || display.body.kind === "diff";
    if (!policied && !env.expanded && !display.defaultExpanded) {
      this.body.setText("");
      return;
    }
    // Reduced width keeps pre-fit diff renderers from overflowing the indent.
    const indent = "   ";
    const bodyEnv: Env = { ...env, width: Math.max(1, env.width - indent.length) };
    const rendered = renderBody(display.body, bodyEnv, this.handle.cell.diff);
    if (!rendered.trim()) {
      this.body.setText("");
      return;
    }
    const ok = display.status?.exitCode === null || display.status?.exitCode === 0;
    const arrow = ok ? theme.fg("muted", "└") : theme.fg("error", "└");
    const lines = rendered.split("\n");
    lines[0] = ` ${arrow} ${lines[0]}`;
    for (let i = 1; i < lines.length; i++) lines[i] = `${indent}${lines[i]}`;
    this.body.setText(lines.join("\n"));
  }
}

export function mountCall<S>(model: RenderModel<S>, args: MountArgs, env: MountEnv): ToolCallView {
  const handle = handleFor(args, model, env);
  const comp = new SchemaCallComponent(handle as RenderHandle<unknown>);
  return {
    node: comp as unknown as RenderNode,
    setStatus: (opts) => comp.setStatus(opts),
  };
}

export function mountResult<S>(model: RenderModel<S>, args: MountArgs, env: MountEnv): ToolResultView {
  const handle = handleFor(args, model, env);
  const comp = new SchemaResultComponent(handle as RenderHandle<unknown>);
  return {
    node: comp as unknown as RenderNode,
    appendChunk: (chunk) => comp.appendChunk(chunk),
    setDiffRenderer: (fn) => comp.setDiffRenderer(fn),
    finalize: (opts) => comp.finalize(opts),
    toggleExpanded: () => comp.toggleExpanded(),
  };
}
