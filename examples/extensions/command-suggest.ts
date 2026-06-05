/**
 * command-suggest extension
 *
 * Registers the suggest_command tool. When the agent calls it, the response
 * finishes and the user drops to the shell prompt with the command pre-typed
 * — no copy-paste, no mode toggle, just review and press Enter.
 *
 * Usage:
 *   agent-sh -e ./examples/extensions/command-suggest.ts
 *
 *   # Or install permanently:
 *   cp examples/extensions/command-suggest.ts ~/.agent-sh/extensions/
 */
import type { ExtensionContext } from "agent-sh/types";

export default function activate(ctx: ExtensionContext): void {
  const { bus } = ctx;
  let pendingCommand: string | null = null;

  // ── Tool ────────────────────────────────────────────────────────

  ctx.agent?.registerTool({
    name: "suggest_command",
    description:
      "Stage a shell command at the user's prompt. After this response " +
      "completes, the command appears in their shell prompt (not inside " +
      "agent-input mode), ready to edit or run with Enter. " +
      "Only call this when the user is asking for a command to run, or otherwise " +
      "signals they want one staged — e.g. \"give me the command to …\", " +
      "\"what do I run to …\". Do NOT call it unprompted after a general question, " +
      "an explanation, or any turn where no command was requested. " +
      "Prefer it over telling the user to copy-paste a command. " +
      "Only the most recent call matters. Call with an empty string to clear.",
    input_schema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description:
            "The shell command to place in the user's prompt. " +
            "Multi-line commands are collapsed to a single line.",
        },
      },
      required: ["command"],
    },
    showOutput: true,

    getDisplayInfo: () => ({ icon: "⏎" }),

    formatCall: (args) => {
      const cmd = (args.command as string).trim();
      if (!cmd) return "(clear suggestion)";
      return cmd.length > 60 ? cmd.slice(0, 57) + "..." : cmd;
    },

    async execute(args) {
      const cmd = (args.command as string).trim();
      if (!cmd) {
        pendingCommand = null;
        return { content: "Cleared pending command suggestion.", exitCode: 0, isError: false };
      }
      // Collapse newlines to spaces so the command stays on one readline buffer.
      pendingCommand = cmd.replace(/\n/g, " ");
      return {
        content: `Will suggest at shell prompt: ${pendingCommand}`,
        exitCode: 0,
        isError: false,
      };
    },
  });

  // ── Injection hook ──────────────────────────────────────────────

  // Replace the default handler — which re-enters agent-input mode when sticky —
  // so a pending command lands at a fresh shell prompt instead. The "\n" leads
  // the same PTY write so the new prompt appears before the command text fills it.
  ctx.advise("shell:on-processing-redraw", (next) => {
    if (pendingCommand) {
      const cmd = pendingCommand;
      pendingCommand = null;
      bus.emit("shell:pty-write", { data: "\n" + cmd });
    } else {
      next();
    }
  });
}
