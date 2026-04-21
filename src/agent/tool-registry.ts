import type { ToolDefinition } from "./types.js";
import type { ChatCompletionTool } from "../utils/llm-client.js";
import { registerReadOnlyTool, unregisterReadOnlyTool } from "./nuclear-form.js";

/**
 * Registry for agent tools. Holds tool definitions and converts them
 * to OpenAI-compatible function schemas for API calls.
 */
export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
    if (tool.readOnly) registerReadOnlyTool(tool.name);
    else unregisterReadOnlyTool(tool.name);
  }

  unregister(name: string): void {
    this.tools.delete(name);
    unregisterReadOnlyTool(name);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  all(): ToolDefinition[] {
    return Array.from(this.tools.values());
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
