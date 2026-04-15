/**
 * Subagent extension — lets the main agent spawn focused sub-agents.
 *
 * The main agent gets a `spawn_agent` tool that creates a fresh agent
 * with its own context. The LLM decides how to specialize — no
 * predefined categories, no registry, no config.
 *
 * Usage:
 *   agent-sh -e ./examples/extensions/subagents.ts
 */
import type { ExtensionContext } from "agent-sh/types";
import { runSubagent } from "agent-sh/agent/subagent";

export default function activate(ctx: ExtensionContext): void {
  const { bus, llmClient, contextManager } = ctx;
  if (!llmClient) return;

  const allToolNames = () => ctx.getTools().map(t => t.name);

  ctx.registerTool({
    name: "spawn_agent",
    description:
      "Spawn a subagent with its own fresh context to handle a focused task. " +
      "Use this to delegate work that needs investigation or multiple tool calls, " +
      "without polluting your main conversation context. " +
      "The subagent runs to completion and returns its result.",
    input_schema: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "Clear description of what the subagent should do",
        },
        tools: {
          type: "array",
          items: { type: "string" },
          description: `Tool names the subagent can use. Available: ${allToolNames().join(", ")}`,
        },
      },
      required: ["task"],
    },

    showOutput: false,

    getDisplayInfo: () => ({
      kind: "execute",
    }),

    async execute(args) {
      const task = args.task as string;
      const toolNames = args.tools as string[] | undefined;

      const allTools = ctx.getTools();
      // Filter to requested tools, or give all tools (minus spawn_agent to prevent recursion)
      const tools = toolNames
        ? allTools.filter(t => toolNames.includes(t.name))
        : allTools.filter(t => t.name !== "spawn_agent");

      const systemPrompt =
        `You are a focused subagent. Complete the task and return a clear, concise result.\n` +
        `Working directory: ${contextManager.getCwd()}`;

      try {
        const result = await runSubagent({
          llmClient,
          tools,
          systemPrompt,
          task,
          bus,
          maxIterations: 25,
        });

        return {
          content: result || "(no response)",
          exitCode: 0,
          isError: false,
        };
      } catch (err) {
        return {
          content: `Subagent error: ${err instanceof Error ? err.message : String(err)}`,
          exitCode: 1,
          isError: true,
        };
      }
    },
  });
}
