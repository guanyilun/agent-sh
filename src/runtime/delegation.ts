/** Explicit child capabilities, executed through the parent's policy boundary. */
import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "../shell/host-types.js";
import type { ToolDefinition, ToolResult } from "../agent/types.js";

export interface DelegatedToolsOptions {
  /** Observes streamed output alongside the child's onChunk callback. */
  onProgress?: (name: string, chunk: string) => void;
}

/**
 * Select only explicitly named parent tools for ashEngine({ tools }). Nothing is
 * added implicitly (including tools that spawn more agents). Schemas are copied;
 * options cannot replace tools, schemas, execution, or the parent's policy.
 *
 * The parent's backend must provide tool:execute when a tool is invoked. Never
 * fall back to tool:dispatch or tool.execute: those bypass permission advice.
 */
export function delegatedTools(
  parent: ExtensionContext,
  allowedNames: string[],
  options: DelegatedToolsOptions = {},
): ToolDefinition[] {
  const available = parent.agent?.getTools()
    ?? parent.bus.emitPipe("agent:tools", { tools: [] }).tools;
  const tools = new Map(available.map(tool => [tool.name, tool]));
  return [...new Set(allowedNames)].map(name => {
    const tool = tools.get(name);
    if (!tool) throw new Error(`Cannot delegate unknown parent tool: ${name}`);
    return {
      ...tool,
      input_schema: structuredClone(tool.input_schema),
      async execute(args, onChunk, context) {
        if (!parent.hasBase("tool:execute")) {
          throw new Error(`Cannot execute delegated tool "${name}": parent tool:execute dispatcher is unavailable; activate the parent's agent backend first`);
        }
        const progress = options.onProgress;
        const forwardChunk = progress ? (chunk: string) => {
          onChunk?.(chunk);
          progress(name, chunk);
        } : onChunk;
        return await parent.call("tool:execute", {
          name,
          id: randomUUID(),
          args,
          tool,
          onChunk: forwardChunk,
          // Direct callers may omit a context; never capture a parent run signal.
          signal: context?.signal ?? new AbortController().signal,
          telemetry: false,
          attribution: false,
        }) as ToolResult;
      },
    };
  });
}
