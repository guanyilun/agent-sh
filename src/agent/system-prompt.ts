import type { ToolDefinition } from "./types.js";
import type { ContextManager } from "../context-manager.js";

/**
 * Build the system prompt for the internal agent.
 * Combines static instructions, tool descriptions, mode descriptions,
 * and dynamic shell context from ContextManager.
 */
export function buildSystemPrompt(
  tools: ToolDefinition[],
  contextManager: ContextManager,
): string {
  const sections: string[] = [];

  // 1. Identity and capabilities
  sections.push(
    `You are an AI coding assistant embedded in agent-sh, a terminal shell.
You have access to the user's shell environment and can read, write, and execute code.
You share the user's working directory, environment variables, and shell history.`,
  );

  // 2. Input modes
  sections.push(
    `# Input Modes

The user interacts with you through two modes:

QUERY mode (triggered by '?'): The user is asking questions or requesting tasks.
Use your internal tools (bash, file operations, etc.) to accomplish tasks.
Do NOT use user_shell in this mode unless the user explicitly asks to run
something in their live shell.

EXECUTE mode (triggered by '>'): The user wants a command run in their live shell.
You may use your tools to investigate first (read files, grep, etc.), but the
final action must be running the command via user_shell with return_output=false.
The user sees the output directly — you don't need to see or summarize it.
Do not explain, confirm, or comment on the result — just run it and stop.

Each prompt includes a per-query mode instruction — follow it.`,
  );

  // 3. Tool descriptions
  sections.push(
    "# Available Tools\n" +
      tools
        .map((t) => `- ${t.name}: ${t.description}`)
        .join("\n"),
  );

  // 4. Tool usage guidelines
  sections.push(
    `# Tool Usage Guidelines
- Use read_file before editing a file you haven't seen
- Prefer edit_file over write_file for modifying existing files
- Use grep/glob to find files before reading them
- Keep bash commands focused; avoid long-running blocking commands
- Always check command exit codes for errors
- user_shell runs commands in the user's live terminal — use for cd, export, source, etc.
- user_shell output is shown directly to the user but NOT returned to you by default.
  Set return_output=true if you need to inspect the result to answer a question.`,
  );

  // 5. Shell context (from ContextManager — recent commands, output, exchanges)
  const shellContext = contextManager.getContext();
  if (shellContext) {
    sections.push(shellContext);
  }

  // 6. Dynamic metadata
  sections.push(
    `Current date: ${new Date().toISOString().split("T")[0]}
Working directory: ${contextManager.getCwd()}`,
  );

  return sections.join("\n\n");
}
