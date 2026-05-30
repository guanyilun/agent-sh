import type { ExtensionContext } from "agent-sh/types";
import type { Renderer, RenderNodes, ToolCallView, ToolResultView } from "./renderer.js";
import { UserMessage } from "./chat/user-message.js";
import { AssistantMessage, type EquationRenderer } from "./chat/assistant.js";
import { ThinkingBlock } from "./chat/thinking.js";
import { loadDisplayResolver, type ToolResultMode } from "./display-config.js";
import { isRenderModel, type RenderModel } from "./schema.js";

export interface RenderState {
  state: Record<string, unknown>;
  invalidate: () => void;
  nodes: RenderNodes;
}

export interface UserMessageArgs extends RenderState { text: string }
export interface AssistantArgs extends RenderState { text: string }
export interface ThinkingArgs extends RenderState { text: string; hidden: boolean }

const SCHEMA_PREFIX = "ashi:render-tool:";

export function registerRenderDefaults(ctx: ExtensionContext, renderer: Renderer): void {
  // Cache the PNG, not the node: finalize/rehydrate can render an equation twice.
  const equationPng = new Map<string, Buffer | null>();
  const renderEquation: EquationRenderer = (src) => {
    if (!equationPng.has(src)) {
      equationPng.set(src, (ctx.call("latex:render-equation", src) as Buffer | null) ?? null);
    }
    const png = equationPng.get(src) ?? null;
    return png && renderer.capabilities.images ? renderer.image(png) : null;
  };

  ctx.define("ashi:render-user-message", (args: UserMessageArgs) =>
    new UserMessage(renderer, args.text));

  ctx.define("ashi:render-assistant", (args: AssistantArgs) => {
    const eq = ctx.list().includes("latex:render-equation") ? renderEquation : undefined;
    const msg = new AssistantMessage(renderer, eq);
    if (args.text) {
      msg.appendText(args.text);
      msg.finalize();
    }
    return msg;
  });

  ctx.define("ashi:render-thinking", (args: ThinkingArgs) => {
    const tb = new ThinkingBlock(renderer);
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
  modeFor: (name: string) => { mode: ToolResultMode; previewLines: number; expandedLines: number };
}

export function createToolHookResolver(
  ctx: ExtensionContext,
  renderer: Renderer,
): ToolHookResolver & { refresh: () => void } {
  const resolver = loadDisplayResolver();
  let registered = new Set(ctx.list());

  const schemaModel = (name: string): RenderModel<unknown> => {
    for (const candidate of [`${SCHEMA_PREFIX}${name}`, `${SCHEMA_PREFIX}default`]) {
      if (!registered.has(candidate)) continue;
      const v = ctx.call(candidate, {}) as unknown;
      if (isRenderModel(v)) return v;
    }
    throw new Error(`no render model for tool "${name}" and no ${SCHEMA_PREFIX}default registered`);
  };

  const initialWidth = (): number => process.stdout.columns ?? 80;

  return {
    refresh(): void {
      registered = new Set(ctx.list());
    },
    modeFor(name: string) {
      const e = resolver.resolve(name, schemaModel(name).display);
      return { mode: e.result, previewLines: e.previewLines, expandedLines: e.expandedLines };
    },
    call(args) {
      const { mode, previewLines, expandedLines } = this.modeFor(args.name);
      return renderer.mountToolCall(schemaModel(args.name), args,
        { width: initialWidth(), mode, previewLines, expandedLines });
    },
    result(args) {
      const { mode, previewLines, expandedLines } = this.modeFor(args.name);
      return renderer.mountToolResult(schemaModel(args.name), { ...args, title: args.name },
        { width: initialWidth(), mode, previewLines, expandedLines });
    },
  };
}
