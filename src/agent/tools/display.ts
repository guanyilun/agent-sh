import type { EventBus } from "../../event-bus.js";
import type { ToolDefinition } from "../types.js";

/**
 * display — shows command output to the user in their live terminal.
 *
 * Unlike bash (scratchpad), the user sees the output directly in their shell.
 * This is for read-only display — no lasting side effects.
 * The agent does NOT receive the output back.
 */
export function createDisplayTool(opts: {
  getCwd: () => string;
  bus: EventBus;
}): ToolDefinition {
  return {
    name: "display",
    description:
      "Show command output to the user in their terminal. Use when the user asks to see something (cat, git log, diff, man, etc.) and you don't need to process the output yourself. Output is NOT returned to you.",
    input_schema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "Command to run and display output to the user",
        },
        timeout: {
          type: "number",
          description: "Timeout in seconds (default: 30)",
        },
      },
      required: ["command"],
    },

    showOutput: false,
    modifiesFiles: false,

    getDisplayInfo: () => ({
      kind: "display" as const,
      icon: "◇",
      locations: [],
    }),

    async execute(args) {
      const command = args.command as string;
      const timeoutSec = (args.timeout as number) ?? 30;

      let result: { output: string; exitCode: number | null; [k: string]: unknown };
      try {
        const execPromise = opts.bus.emitPipeAsync(
          "shell:exec-request",
          {
            command,
            output: "",
            cwd: opts.getCwd(),
            exitCode: null as number | null,
            done: false,
          },
        );
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), timeoutSec * 1000),
        );
        result = await Promise.race([execPromise, timeoutPromise]);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg === "timeout") {
          return {
            content: `Command timed out after ${timeoutSec}s.`,
            exitCode: -1,
            isError: true,
          };
        }
        return { content: `Error: ${msg}`, exitCode: -1, isError: true };
      }

      const exitCode = result.exitCode ?? 0;
      const isError = exitCode !== 0 && exitCode !== null;

      return {
        content: isError
          ? `Command failed with exit code ${exitCode}.`
          : "Output displayed to user.",
        exitCode,
        isError,
      };
    },
  };
}
