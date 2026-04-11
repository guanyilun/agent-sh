/**
 * Subagent extension — delegates tasks to focused sub-agents.
 *
 * Instead of the main agent handling everything with its full context,
 * subagents each get a clean, specialized context for their task.
 * The main agent becomes a router that delegates to the right specialist.
 *
 * Usage:
 *   agent-sh -e ./examples/extensions/subagents.ts
 *
 * The main agent gets a `delegate` tool that dispatches to subagents.
 * Each subagent has its own system prompt and tool subset.
 */
import type { ExtensionContext } from "../../src/types.js";
import type { ToolDefinition } from "../../src/agent/types.js";
import { runSubagent } from "../../src/agent/subagent.js";

interface SubagentConfig {
  name: string;
  description: string;
  systemPrompt: string;
  /** Tool names this subagent can use. If omitted, gets all tools. */
  toolNames?: string[];
  /** Model override for this subagent (e.g., cheaper model for simple tasks). */
  model?: string;
}

export default function activate(ctx: ExtensionContext): void {
  const { bus, llmClient, contextManager } = ctx;
  if (!llmClient) return;

  const subagents: SubagentConfig[] = [
    {
      name: "researcher",
      description: "Investigate codebase questions — reads files, searches code, explores structure. Use for questions that need reading multiple files.",
      systemPrompt: `You are a code researcher working in a terminal.
Your job is to investigate questions about the codebase and provide clear, concise answers.
You have read-only tools — use them to find the information needed.
Be thorough but focused. Return a direct answer, not a plan.
Working directory: {{cwd}}`,
      toolNames: ["read_file", "grep", "glob", "ls", "bash"],
    },
    {
      name: "editor",
      description: "Make code changes — edit files, create new files, refactor. Use when changes need to be made to the codebase.",
      systemPrompt: `You are a code editor working in a terminal.
Your job is to make the requested changes to the codebase.
Read files before editing. Prefer edit_file over write_file for existing files.
Make minimal, focused changes. Do not add unnecessary comments or refactoring.
Working directory: {{cwd}}`,
      toolNames: ["read_file", "write_file", "edit_file", "grep", "glob", "ls", "bash"],
    },
    {
      name: "shell",
      description: "Run shell commands and interpret results — build, test, deploy, git operations. Use for tasks that primarily involve running commands.",
      systemPrompt: `You are a shell assistant working in a terminal.
Your job is to run commands and interpret their results.
Use bash for isolated commands. Be concise in your responses.
Working directory: {{cwd}}`,
      toolNames: ["bash", "read_file", "ls"],
    },
  ];

  // Build the delegate tool
  ctx.registerTool({
    name: "delegate",
    description: `Delegate a task to a specialized subagent. Available subagents:\n${
      subagents.map(s => `- ${s.name}: ${s.description}`).join("\n")
    }`,
    input_schema: {
      type: "object",
      properties: {
        agent: {
          type: "string",
          description: `Which subagent to use: ${subagents.map(s => s.name).join(", ")}`,
          enum: subagents.map(s => s.name),
        },
        task: {
          type: "string",
          description: "The task for the subagent to perform",
        },
      },
      required: ["agent", "task"],
    },

    getDisplayInfo: (args) => ({
      kind: "execute",
      locations: [],
    }),

    async execute(args) {
      const agentName = args.agent as string;
      const task = args.task as string;

      const config = subagents.find(s => s.name === agentName);
      if (!config) {
        return {
          content: `Unknown subagent: ${agentName}`,
          exitCode: 1,
          isError: true,
        };
      }

      // Resolve tool subset
      const allTools = ctx.getTools();
      const tools = config.toolNames
        ? allTools.filter(t => config.toolNames!.includes(t.name))
        : allTools;

      // Build system prompt with current context
      const systemPrompt = config.systemPrompt
        .replace("{{cwd}}", contextManager.getCwd());

      try {
        const result = await runSubagent({
          llmClient,
          tools,
          systemPrompt,
          task,
          model: config.model,
          bus,
          maxIterations: 25,
        });

        return {
          content: result || "(subagent returned no response)",
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
