/** Tool execution for surface-only hosts, before an AgentLoop installs telemetry. */
import type { ExtensionContext } from "../shell/host-types.js";
import type { AgentToolDispatchInput } from "./run-contract.js";
import type { ToolDefinition, ToolResult } from "./types.js";

const installed = new WeakSet<ExtensionContext>();

export function ensureToolDispatcher(ctx: ExtensionContext): void {
  if (installed.has(ctx)) return;
  installed.add(ctx);

  const currentTool = (name: string): ToolDefinition => {
    const tool = ctx.agent?.getTools().find(tool => tool.name === name);
    if (!tool || !ctx.list().includes(`tool:${name}`)) {
      throw new Error(`Tool "${name}" is unavailable`);
    }
    return tool;
  };

  if (!ctx.list().includes("tool:dispatch")) {
    ctx.define("tool:dispatch", async ({ name, args, onChunk, context }: AgentToolDispatchInput): Promise<ToolResult> => {
      currentTool(name);
      context.signal?.throwIfAborted();
      // Never execute the caller-supplied implementation; retain named advice.
      return await ctx.call(`tool:${name}`, args, onChunk, context);
    });
  }

  // Do not use list() as a base-presence check: policy advice alone creates an
  // entry. define() installs the base without removing any existing advisors.
  ctx.define("tool:execute", async (input: {
    name: string;
    args: Record<string, unknown>;
    tool: ToolDefinition;
    onChunk?: (chunk: string) => void;
    signal: AbortSignal;
  }): Promise<ToolResult> => {
    const { name, args, signal } = input;
    if (typeof name !== "string" || !name || !input.tool || input.tool.name !== name) {
      throw new Error("Invalid tool execution: tool and name must match");
    }
    const tool = currentTool(name);
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      throw new Error(`Invalid arguments for tool "${name}": expected an object`);
    }
    signal.throwIfAborted();
    const required = Array.isArray(tool.input_schema?.required) ? tool.input_schema.required as string[] : [];
    const missing = required.filter(key => args[key] === undefined || args[key] === null);
    if (missing.length) {
      return {
        content: `Missing required argument(s): ${missing.join(", ")}. Expected: ${required.join(", ")}. Received: ${Object.keys(args).join(", ") || "(none)"}`,
        exitCode: 1, isError: true,
      };
    }
    return await ctx.call("tool:dispatch", {
      name, args, tool, onChunk: input.onChunk, context: { signal },
    } satisfies AgentToolDispatchInput);
  });
}
