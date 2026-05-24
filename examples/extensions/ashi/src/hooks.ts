import type { Component } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "agent-sh/types";
import {
  AssistantMessage,
  ThinkingBlock,
  ToolResultBody,
  UserMessage,
} from "./components.js";
import { entryFor, loadToolDisplayConfig, type ToolResultMode } from "./display-config.js";
import { isRenderModel, mountCall, mountResult, type RenderModel } from "./schema.js";

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
 *  if they encode status differently (e.g. a sigil in the call line).
 *  Optional toggleExpanded lets long labels (e.g. bash commands) reveal
 *  their full form on Ctrl+O. */
export interface ToolCallView extends Component {
  setStatus(opts: { exitCode: number | null; elapsedMs: number; summary?: string }): void;
  toggleExpanded?(): void;
}

/** Mutated by ashi as output streams in and when the tool completes.
 *  setDiffRenderer is optional behavior — renderers may no-op if they don't
 *  show diffs. The renderer is called on each terminal-width change so diffs
 *  reflow on resize. toggleExpanded flips the view's internal expansion state
 *  (Ctrl+O). */
export interface ToolResultView extends Component {
  appendChunk(chunk: string): void;
  setDiffRenderer(fn: (width: number) => string[]): void;
  finalize(opts: { exitCode: number | null; summary?: string }): void;
  toggleExpanded(): void;
}

const CALL_PREFIX = "ashi:render-tool-call:";
const RESULT_PREFIX = "ashi:render-tool-result:";
const SCHEMA_PREFIX = "ashi:render-tool:";

/** Register the default render-* handlers. Per-tool overrides are advised by
 *  name (e.g. `ashi:render-tool-call:bash`); unknown tools fall back to
 *  `:default`. */
export function registerRenderDefaults(ctx: ExtensionContext): void {
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
  ctx: ExtensionContext,
  renderState: () => RenderState,
): ToolHookResolver & { refresh: () => void } {
  const config = loadToolDisplayConfig();
  let registered = new Set(ctx.list());

  const pick = (prefix: string, name: string): string => {
    const specific = `${prefix}${name}`;
    return registered.has(specific) ? specific : `${prefix}default`;
  };

  const schemaModel = (name: string): RenderModel<unknown> | undefined => {
    for (const candidate of [`${SCHEMA_PREFIX}${name}`, `${SCHEMA_PREFIX}default`]) {
      if (!registered.has(candidate)) continue;
      const v = ctx.call(candidate, {}) as unknown;
      if (isRenderModel(v)) return v;
    }
    return undefined;
  };

  // TODO: pull from the live TuiFrame so the first paint isn't cold-width.
  const initialWidth = (): number => process.stdout.columns ?? 80;

  return {
    refresh(): void {
      registered = new Set(ctx.list());
    },
    modeFor(name: string) {
      const e = entryFor(config, name);
      return { mode: e.result, previewLines: e.previewLines };
    },
    call(args) {
      const model = schemaModel(args.name);
      if (model) {
        const { mode, previewLines } = this.modeFor(args.name);
        return mountCall(model, {
          toolCallId: args.toolCallId,
          name: args.name,
          title: args.title,
          kind: args.kind,
          displayDetail: args.displayDetail,
          rawInput: args.rawInput,
        }, { width: initialWidth(), mode, previewLines }) as ToolCallView;
      }
      const handler = pick(CALL_PREFIX, args.name);
      return ctx.call(handler, { ...renderState(), ...args }) as ToolCallView;
    },
    result(args) {
      const model = schemaModel(args.name);
      if (model) {
        const { mode, previewLines } = this.modeFor(args.name);
        return mountResult(model, {
          toolCallId: args.toolCallId,
          name: args.name,
          title: args.name,
          rawInput: args.rawInput,
        }, { width: initialWidth(), mode, previewLines }) as ToolResultView;
      }
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
