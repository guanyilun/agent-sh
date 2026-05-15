import type { Component } from "@earendil-works/pi-tui";
import type { ShellContext } from "agent-sh/types";
import {
  AssistantMessage,
  ThinkingBlock,
  ToolResultBody,
  UserMessage,
} from "./components.js";
import { entryFor, loadToolDisplayConfig, type ToolResultMode } from "./display-config.js";

export interface RenderState {
  state: Record<string, unknown>;
  invalidate: () => void;
}

export interface UserMessageArgs extends RenderState { text: string }

export interface AssistantArgs extends RenderState { text: string }

export interface ThinkingArgs extends RenderState { text: string; hidden: boolean }

export interface ToolCallArgs extends RenderState {
  toolCallId: string;
  name: string;
  title: string;
  kind?: string;
  displayDetail?: string;
  rawInput?: unknown;
}

export interface ToolResultArgs extends RenderState {
  toolCallId: string;
  name: string;
  kind?: string;
  rawInput?: unknown;
  /** Resolved from ashi.display.{name} (or .default) in settings.json. */
  mode: ToolResultMode;
  previewLines: number;
}

/** Mutated by ashi when the tool completes. Renderers may ignore setStatus
 *  if they encode status differently (e.g. a sigil in the call line). */
export interface ToolCallView extends Component {
  setStatus(opts: { exitCode: number | null; elapsedMs: number; summary?: string }): void;
}

/** Mutated by ashi as output streams in and when the tool completes.
 *  setDiff is optional behavior — renderers may no-op if they don't show diffs.
 *  toggleExpanded flips the view's internal expansion state (Ctrl+O). */
export interface ToolResultView extends Component {
  appendChunk(chunk: string): void;
  setDiff(lines: string[]): void;
  finalize(opts: { exitCode: number | null; summary?: string }): void;
  toggleExpanded(): void;
}

const CALL_PREFIX = "ashi:render-tool-call:";
const RESULT_PREFIX = "ashi:render-tool-result:";

/** Register the default render-* handlers. Per-tool overrides are advised by
 *  name (e.g. `ashi:render-tool-call:bash`); unknown tools fall back to
 *  `:default`. */
export function registerRenderDefaults(ctx: ShellContext): void {
  ctx.define("ashi:render-user-message", (args: UserMessageArgs): Component => {
    return new UserMessage(args.text);
  });

  ctx.define("ashi:render-assistant", (args: AssistantArgs): Component => {
    const msg = new AssistantMessage();
    if (args.text) {
      msg.appendText(args.text);
      msg.finalize();
    }
    return msg;
  });

  ctx.define("ashi:render-thinking", (args: ThinkingArgs): Component => {
    const tb = new ThinkingBlock();
    if (args.text) {
      tb.appendText(args.text);
      tb.finalize();
    }
    tb.setHidden(args.hidden);
    return tb;
  });

  ctx.define(`${RESULT_PREFIX}default`, (args: ToolResultArgs): ToolResultView => {
    return new ToolResultBody(args.mode, args.previewLines);
  });
}

export interface ToolHookResolver {
  call: (args: Omit<ToolCallArgs, "state" | "invalidate"> & Partial<RenderState>) => ToolCallView;
  result: (args: Omit<ToolResultArgs, "mode" | "previewLines" | "state" | "invalidate"> & Partial<RenderState>) => ToolResultView;
  modeFor: (name: string) => { mode: ToolResultMode; previewLines: number };
}

/** Resolves :{name} → :default for tool render hooks and looks up each tool's
 *  display mode from ashi.display. Cache the registered-handler set; callers
 *  can `refresh()` after extensions register new tool-specific renderers. */
export function createToolHookResolver(
  ctx: ShellContext,
  renderState: () => RenderState,
): ToolHookResolver & { refresh: () => void } {
  const config = loadToolDisplayConfig();
  let registered = new Set(ctx.list());

  const pick = (prefix: string, name: string): string => {
    const specific = `${prefix}${name}`;
    return registered.has(specific) ? specific : `${prefix}default`;
  };

  return {
    refresh(): void {
      registered = new Set(ctx.list());
    },
    modeFor(name: string) {
      const e = entryFor(config, name);
      return { mode: e.result, previewLines: e.previewLines };
    },
    call(args) {
      const handler = pick(CALL_PREFIX, args.name);
      return ctx.call(handler, { ...renderState(), ...args }) as ToolCallView;
    },
    result(args) {
      const { mode, previewLines } = this.modeFor(args.name);
      const handler = pick(RESULT_PREFIX, args.name);
      return ctx.call(handler, {
        ...renderState(),
        ...args,
        mode,
        previewLines,
      }) as ToolResultView;
    },
  };
}
