import { executeArgv, killSession } from "../../executor.js";
import type { EventBus } from "../../event-bus.js";
import type { ToolDefinition } from "../types.js";

// Targets PowerShell 7+ (`pwsh`). Legacy `powershell.exe` is intentionally
// not auto-fallback — its tool surface diverges enough that compatibility
// shims aren't worth the maintenance.
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
        file: "pwsh",
        args: ["-NoProfile", "-NonInteractive", "-Command", command],
        cwd: opts.getCwd(),
        env: opts.getEnv(),
        timeout,
        onOutput: onChunk,
      });

      const onAbort = () => killSession(session);
      ctx?.signal?.addEventListener("abort", onAbort, { once: true });
      try {
        await done;
      } finally {
        ctx?.signal?.removeEventListener("abort", onAbort);
      }

      if (session.spawnFailed) {
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
