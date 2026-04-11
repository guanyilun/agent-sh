import type { EventBus } from "../../event-bus.js";
import type { ToolDefinition } from "../types.js";

/**
 * user_shell — runs commands in the user's live PTY shell.
 *
 * Unlike bash, this affects the user's shell state (cd, export, source).
 * Output is shown directly in the terminal. By default, the agent doesn't
 * see the output (return_output=false) to save tokens.
 */
export function createUserShellTool(opts: {
  getCwd: () => string;
  bus: EventBus;
}): ToolDefinition {
  return {
    name: "user_shell",
    description:
      "Run a command in the user's live shell (visible in terminal). Output is returned to you by default. Use for cd, export, source, or commands the user wants to see. Set return_output=false for long-running or interactive commands.",
    input_schema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "Command to execute in user's shell",
        },
        return_output: {
          type: "boolean",
          default: false,
          description:
            "Whether to return the command output to you. Default false — output is shown directly to the user. Set true only if you need to inspect the result to answer a question.",
        },
      },
      required: ["command"],
    },

    showOutput: false,
    modifiesFiles: true,

    getDisplayInfo: () => ({
      kind: "execute",
      locations: [],
    }),

    async execute(args) {
      const command = args.command as string;
      const returnOutput = (args.return_output as boolean) ?? false;

      // Execute via the shell-exec extension's async pipe
      const result = await opts.bus.emitPipeAsync(
        "shell:exec-request",
        {
          command,
          output: "",
          cwd: opts.getCwd(),
          done: false,
        },
      );

      if (returnOutput) {
        return {
          content: result.output || "(no output)",
          exitCode: 0,
          isError: false,
        };
      }

      return {
        content: "Command executed.",
        exitCode: 0,
        isError: false,
      };
    },
  };
}
