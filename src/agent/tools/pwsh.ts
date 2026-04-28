import { executeArgv } from "../../executor.js";
import type { EventBus } from "../../event-bus.js";
import type { ToolDefinition } from "../types.js";

// Use modern PowerShell 7+ (`pwsh`). Windows users without it can install via
// `winget install Microsoft.PowerShell`. Legacy Windows PowerShell 5
// (`powershell.exe`) is intentionally not auto-fallback — its tool surface
// and behavior diverge enough that "it works on my machine" failures aren't
// worth the polyfill code.
const PWSH_BIN = "pwsh";

export function createPwshTool(opts: {
  getCwd: () => string;
  getEnv: () => Record<string, string>;
  bus: EventBus;
}): ToolDefinition {
  return {
    name: "pwsh",
    description:
      "Execute a PowerShell command in an isolated subprocess. " +
      "Use this on Windows when the `bash` tool fails (no /bin/bash available). " +
      "Use PowerShell syntax — e.g. `Get-ChildItem`, `Select-String`, `$env:HOME`. " +
      "Does not affect the user's shell state. " +
      "cwd is set to the working directory from the shell context. " +
      "Do NOT use pwsh for file searching — use grep/glob instead. " +
      "Do NOT use pwsh for reading files — use read_file instead.",
    input_schema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The PowerShell command to execute",
        },
        timeout: {
          type: "number",
          description: "Timeout in seconds (default: 60)",
        },
        description: {
          type: "string",
          description:
            "Short description of what this command does (e.g., 'Install dependencies', 'Run test suite')",
        },
      },
      required: ["command"],
    },

    showOutput: true,
    modifiesFiles: true,
    requiresPermission: true,

    getDisplayInfo: () => ({
      kind: "execute",
      icon: "▶",
      locations: [],
    }),

    async execute(args, onChunk, ctx) {
      const command = args.command as string;
      const timeout = ((args.timeout as number) ?? 60) * 1000;

      // Let extensions intercept before execution
      const intercepted = opts.bus.emitPipe("agent:terminal-intercept", {
        command,
        cwd: opts.getCwd(),
        intercepted: false,
        output: "",
      });
      if (intercepted.intercepted) {
        return {
          content: intercepted.output,
          exitCode: 0,
          isError: false,
        };
      }

      const { session, done } = executeArgv({
        file: PWSH_BIN,
        args: ["-NoProfile", "-NonInteractive", "-Command", command],
        cwd: opts.getCwd(),
        env: opts.getEnv(),
        timeout,
        onOutput: onChunk,
      });

      const onAbort = () => {
        try { session.process?.kill("SIGTERM"); } catch {}
      };
      ctx?.signal?.addEventListener("abort", onAbort, { once: true });
      try {
        await done;
      } finally {
        ctx?.signal?.removeEventListener("abort", onAbort);
      }

      if (session.exitCode === -1 && session.output.startsWith("Failed to spawn")) {
        return {
          content: "PowerShell (pwsh) not found on PATH. Install PowerShell 7: winget install Microsoft.PowerShell.",
          exitCode: 1,
          isError: true,
        };
      }

      const content = session.truncated
        ? `[output truncated, showing last portion]\n${session.output}`
        : session.output;

      return {
        content: content || "(no output)",
        exitCode: session.exitCode,
        isError: session.exitCode !== 0,
      };
    },
  };
}
