/**
 * Pure transition for the `!`-triggered shell mode in the editor.
 *
 * Called from `editor.onChange`. Returning a `replaceText` means the caller
 * must call `editor.setText(replaceText)` to strip the `!` (which will
 * re-enter this function with the stripped text, hitting the no-op branch).
 */
export interface ShellModeTransition {
  mode: boolean;
  replaceText?: string;
}

export function deriveShellModeTransition(
  mode: boolean,
  text: string,
): ShellModeTransition {
  if (!mode && text.startsWith("!")) {
    return { mode: true, replaceText: text.slice(1) };
  }
  // Sticky: shell mode is exited explicitly via Backspace-on-empty (caught
  // by the TUI input listener, not onChange). Auto-exiting on empty text
  // would also exit on pi-tui's pre-emptive onChange("") fired before
  // onSubmit, breaking the routing decision in the same handler.
  return { mode };
}

/**
 * Classify an editor submit into the action the frontend should dispatch.
 *
 * Pure so callers must capture `shellMode` *before* any state mutation —
 * notably before `editor.setText("")`, which fires `onChange("")` and can
 * flip the mode off mid-handler.
 */
export type SubmitAction =
  | { kind: "noop" }
  | { kind: "shell"; line: string }
  | { kind: "command"; name: string; args: string }
  | { kind: "agent"; query: string };

export function classifySubmit(text: string, shellMode: boolean): SubmitAction {
  const query = text.trim();
  if (!query) return { kind: "noop" };
  if (shellMode) return { kind: "shell", line: query };
  if (query.startsWith("/")) {
    const sp = query.indexOf(" ");
    const name = sp === -1 ? query : query.slice(0, sp);
    const args = sp === -1 ? "" : query.slice(sp + 1).trim();
    return { kind: "command", name, args };
  }
  return { kind: "agent", query };
}
