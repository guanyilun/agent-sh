import type { ToolDefinition, ToolResult } from "./types.js";
import type { ChatCompletionTool } from "../utils/llm-client.js";
import type { HandlerFunctions } from "../utils/handler-registry.js";
import { registerReadOnlyTool, unregisterReadOnlyTool } from "./nuclear-form.js";

/**
 * Registry for agent tools. Execution is routed through the named-handler
 * registry under `tool:<name>` so extensions can `advise` a tool without
 * owning it; duplicate `register` calls throw rather than silently evict.
 */
export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();

  constructor(private handlers: HandlerFunctions) {}

  register(tool: ToolDefinition): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" already registered. Use ctx.adviseTool() to wrap it.`);
    }
    this.tools.set(tool.name, tool);
    this.handlers.define(`tool:${tool.name}`, tool.execute.bind(tool));
    if (tool.readOnly) registerReadOnlyTool(tool.name);
    else unregisterReadOnlyTool(tool.name);
  }

  unregister(name: string): void {
    this.tools.delete(name);
    unregisterReadOnlyTool(name);
    // The handler entry is intentionally left in place: any advisors a
    // user extension installed against `tool:<name>` survive a reload of
    // the tool's owner, and are picked up when the same name re-registers.
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  all(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  call(name: string, ...args: Parameters<ToolDefinition["execute"]>): Promise<ToolResult> {
    return this.handlers.call(`tool:${name}`, ...args) as Promise<ToolResult>;
  }

  /** Convert to OpenAI-compatible tool schemas for API calls. */
  toAPITools(): ChatCompletionTool[] {
    return this.all().map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      },
    }));
  }
}
