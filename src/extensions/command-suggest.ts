/**
 * Command suggestion extension (fast-path LLM feature).
 *
 * After a shell command fails (non-zero exit), uses llmClient.complete()
 * to suggest a fix. Shows the suggestion below the prompt.
 *
 * Only active when llmClient is available (internal agent mode).
 */
import type { ExtensionContext } from "../types.js";

export default function activate({ bus, llmClient }: ExtensionContext): void {
  if (!llmClient) return;

  let suggesting = false;

  bus.on("shell:command-done", ({ command, output, exitCode, cwd }) => {
    if (exitCode === null || exitCode === 0) return;
    if (!command.trim()) return;
    if (suggesting) return; // don't stack suggestions

    suggesting = true;

    // Truncate output to avoid blowing up the prompt
    const truncated = output.length > 1000
      ? output.slice(-1000)
      : output;

    llmClient.complete({
      messages: [
        {
          role: "system",
          content:
            "You are a shell assistant. The user's command failed. " +
            "Suggest a fix as a single command. Just the command, no explanation, no backticks, no prefix. " +
            "If you can't suggest anything useful, reply with an empty string.",
        },
        {
          role: "user",
          content: `cwd: ${cwd}\n$ ${command}\n${truncated}\nexit code: ${exitCode}`,
        },
      ],
      max_tokens: 150,
    }).then((suggestion) => {
      suggesting = false;
      const trimmed = suggestion.trim().replace(/^`+|`+$/g, ""); // strip backticks
      if (trimmed && trimmed.length < 500) {
        bus.emit("ui:suggestion", { text: trimmed });
      }
    }).catch(() => {
      suggesting = false;
    });
  });
}
