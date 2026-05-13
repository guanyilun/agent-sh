import type { Component } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "agent-sh/types";
import { AssistantMessage, ThinkingBlock, ToolExecution, UserMessage } from "./components.js";

export interface RenderState {
  state: Record<string, unknown>;
  invalidate: () => void;
}

export interface UserMessageArgs extends RenderState { text: string }

export interface AssistantArgs extends RenderState { text: string }

export interface ThinkingArgs extends RenderState { text: string; hidden: boolean }

export interface ToolExecutionArgs extends RenderState {
  toolCallId: string;
  name: string;
  title: string;
  kind?: string;
  displayDetail?: string;
  rawInput?: unknown;
}

/** ToolExecutionView is the contract a tool-execution renderer must satisfy.
 *  ashi mutates the returned component as the tool progresses; custom
 *  renderers must accept these mutations or override them at the bus level. */
export interface ToolExecutionView extends Component {
  appendOutput(chunk: string): void;
  setBody(lines: string[]): void;
  complete(exitCode: number | null, summary?: string): void;
}

/** Register the default render-* handlers. Extensions advise these names
 *  via ctx.advise to override or wrap. ashi's frontend.ts only ever calls
 *  ctx.call("ashi:render-*", args), never instantiates components directly. */
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

  ctx.define("ashi:render-tool-execution", (args: ToolExecutionArgs): ToolExecutionView => {
    return new ToolExecution(args.title, args.kind, args.displayDetail);
  });
}
