import type { Component } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "agent-sh/types";
import { AssistantMessage, ThinkingBlock, UserMessage } from "./components.js";
import { entryFor, loadToolDisplayConfig, type ToolResultMode } from "./display-config.js";
import { isRenderModel, mountCall, mountResult, type RenderModel } from "./schema.js";

export interface RenderState {
  state: Record<string, unknown>;
  invalidate: () => void;
}

export interface UserMessageArgs extends RenderState { text: string }
export interface AssistantArgs extends RenderState { text: string }
export interface ThinkingArgs extends RenderState { text: string; hidden: boolean }

/** The contract ashi's frontend mutates on the call-side component. Schema
 *  renderers satisfy this via SchemaCallComponent — extension authors don't
 *  implement it directly. */
export interface ToolCallView extends Component {
  setStatus(opts: { exitCode: number | null; elapsedMs: number; summary?: string }): void;
  toggleExpanded?(): void;
}

/** Result-side counterpart. setDiffRenderer receives the width-aware diff
 *  closure produced by the edit/write tool at finalize. */
export interface ToolResultView extends Component {
  appendChunk(chunk: string): void;
  setDiffRenderer(fn: (width: number) => string[]): void;
  finalize(opts: { exitCode: number | null; summary?: string }): void;
  toggleExpanded(): void;
}

const SCHEMA_PREFIX = "ashi:render-tool:";

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
}

export interface ToolCallResolveArgs {
  toolCallId: string;
  name: string;
  title: string;
  kind?: string;
  displayDetail?: string;
  rawInput?: unknown;
}

export interface ToolResultResolveArgs {
  toolCallId: string;
  name: string;
  kind?: string;
  rawInput?: unknown;
}

export interface ToolHookResolver {
  call: (args: ToolCallResolveArgs) => ToolCallView;
  result: (args: ToolResultResolveArgs) => ToolResultView;
  modeFor: (name: string) => { mode: ToolResultMode; previewLines: number };
}

/** Resolves a tool name to a schema RenderModel — :{name} first, then :default.
 *  Cache the registered-handler set; callers can `refresh()` after extensions
 *  register new tool-specific renderers. */
export function createToolHookResolver(
  ctx: ExtensionContext,
): ToolHookResolver & { refresh: () => void } {
  const config = loadToolDisplayConfig();
  let registered = new Set(ctx.list());

  const schemaModel = (name: string): RenderModel<unknown> => {
    for (const candidate of [`${SCHEMA_PREFIX}${name}`, `${SCHEMA_PREFIX}default`]) {
      if (!registered.has(candidate)) continue;
      const v = ctx.call(candidate, {}) as unknown;
      if (isRenderModel(v)) return v;
    }
    throw new Error(`no render model for tool "${name}" and no ${SCHEMA_PREFIX}default registered`);
  };

  // SchemaResultComponent.render(width) corrects env.width on the first frame.
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
      const { mode, previewLines } = this.modeFor(args.name);
      return mountCall(schemaModel(args.name), args,
        { width: initialWidth(), mode, previewLines }) as ToolCallView;
    },
    result(args) {
      const { mode, previewLines } = this.modeFor(args.name);
      return mountResult(schemaModel(args.name), { ...args, title: args.name },
        { width: initialWidth(), mode, previewLines }) as ToolResultView;
    },
  };
}
