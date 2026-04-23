/**
 * Command suggestion extension (fast-path LLM feature).
 *
 * After a shell command fails (non-zero exit), asks the active LLM to
 * suggest a fix. Shows the suggestion below the prompt.
 */
import type { ExtensionContext } from "../types.js";

export default function activate({ bus, llm }: ExtensionContext): void {
  let suggesting = false;

  bus.on("shell:command-done", ({ command, output, exitCode, cwd }) => {
    if (exitCode === null || exitCode === 0) return;
    if (!command.trim()) return;
    if (suggesting) return;
    if (!llm.available) return;

    suggesting = true;
    const truncated = output.length > 1000 ? output.slice(-1000) : output;

    llm.ask({
      system:
        "You are a shell assistant. The user's command failed. " +
        "Suggest a fix as a single command. Just the command, no explanation, no backticks, no prefix. " +
        "If you can't suggest anything useful, reply with an empty string.",
      query: `cwd: ${cwd}\n$ ${command}\n${truncated}\nexit code: ${exitCode}`,
      maxTokens: 150,
    }).then((suggestion) => {
      suggesting = false;
      const trimmed = suggestion.trim().replace(/^`+|`+$/g, "");
      if (trimmed && trimmed.length < 500) {
        bus.emit("ui:suggestion", { text: trimmed });
      }
    }).catch(() => {
      suggesting = false;
    });
  });
}
