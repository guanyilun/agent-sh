/**
 * Command suggestion extension (fast-path LLM feature).
 *
 * After a shell command fails (non-zero exit), uses llmClient.complete()
 * to suggest a fix. Shows the suggestion as dimmed text below the output.
 *
 * Only active when llmClient is available (internal agent mode).
 */
import type { ExtensionContext } from "../types.js";

export default function activate({ bus, llmClient, contextManager }: ExtensionContext): void {
  if (!llmClient) return; // Only active with in-process LLM

  bus.on("shell:command-done", ({ command, output, exitCode, cwd }) => {
    if (exitCode === null || exitCode === 0) return;
    if (!command.trim()) return;

    // Truncate output to avoid blowing up the prompt
    const truncated = output.length > 1000
      ? output.slice(-1000) + "\n[truncated]"
      : output;

    llmClient.complete({
      messages: [
        {
          role: "system",
          content:
            "You are a shell assistant. The user's command failed. " +
            "Suggest a fix in one short line. Just the command, no explanation. " +
            "If you can't suggest anything useful, reply with an empty string.",
        },
        {
          role: "user",
          content: `cwd: ${cwd}\n$ ${command}\n${truncated}\nexit code: ${exitCode}`,
        },
      ],
      max_tokens: 100,
    }).then((suggestion) => {
      const trimmed = suggestion.trim();
      if (trimmed) {
        bus.emit("ui:suggestion", { text: trimmed });
      }
    }).catch(() => {
      // Silently ignore — suggestions are best-effort
    });
  });
}
