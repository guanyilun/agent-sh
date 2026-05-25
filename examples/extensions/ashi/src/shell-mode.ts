export interface ShellModeTransition {
  mode: boolean;
  /** When set, caller must `editor.setText(replaceText)` to strip the `!`. */
  replaceText?: string;
}

export function deriveShellModeTransition(
  mode: boolean,
  text: string,
): ShellModeTransition {
  if (!mode && text.startsWith("!")) {
    return { mode: true, replaceText: text.slice(1) };
  }
  // Sticky on purpose. Exit is via the Backspace-on-empty intercept at the
  // TUI input listener — auto-exiting on empty text would also fire on
  // pi-tui's pre-emptive onChange("") inside Editor.submitValue().
  return { mode };
}

export type SubmitAction =
  | { kind: "noop" }
  | { kind: "shell"; line: string; private: boolean }
  | { kind: "command"; name: string; args: string }
  | { kind: "agent"; query: string };

export function classifySubmit(text: string, shellMode: boolean): SubmitAction {
  const query = text.trim();
  if (!query) return { kind: "noop" };
  if (shellMode) {
    // Second `!` (we stripped the first on entry) opts into private — the
    // exchange runs but is omitted from <shell_events>.
    if (query.startsWith("!")) {
      const line = query.slice(1).trim();
      if (!line) return { kind: "noop" };
      return { kind: "shell", line, private: true };
    }
    return { kind: "shell", line: query, private: false };
  }
  if (query.startsWith("/")) {
    const sp = query.indexOf(" ");
    const name = sp === -1 ? query : query.slice(0, sp);
    const args = sp === -1 ? "" : query.slice(sp + 1).trim();
    return { kind: "command", name, args };
  }
  return { kind: "agent", query };
}
