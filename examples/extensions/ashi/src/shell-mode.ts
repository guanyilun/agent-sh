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

export interface ChangeHandlerResult extends ShellModeTransition {
  /** Whether the next submit (if in shell mode) is marked private. */
  pendingPrivate: boolean;
}

/**
 * Pure onChange transition.
 *
 * Strips `!` (entry), `!!` (entry + private), and in-mode leading `!`
 * (upgrade to private). pendingPrivate is sticky while shell mode is on
 * — auto-clearing on empty text would fire during the entry-strip's
 * recursive onChange("") and lose the signal.
 */
export function deriveChangeHandlerResult(
  mode: boolean,
  pendingPrivate: boolean,
  text: string,
): ChangeHandlerResult {
  if (!mode && text.startsWith("!!")) {
    return { mode: true, replaceText: text.slice(2), pendingPrivate: true };
  }
  if (!mode && text.startsWith("!")) {
    return { mode: true, replaceText: text.slice(1), pendingPrivate: false };
  }
  if (mode && text.startsWith("!")) {
    return { mode: true, replaceText: text.slice(1), pendingPrivate: true };
  }
  return { mode, pendingPrivate: pendingPrivate && mode };
}

export type SubmitAction =
  | { kind: "noop" }
  | { kind: "shell"; line: string; private: boolean }
  | { kind: "command"; name: string; args: string }
  | { kind: "agent"; query: string };

export function classifySubmit(
  text: string,
  shellMode: boolean,
  pendingPrivate: boolean,
): SubmitAction {
  const query = text.trim();
  if (!query) return { kind: "noop" };
  if (shellMode) return { kind: "shell", line: query, private: pendingPrivate };
  if (query.startsWith("/")) {
    const sp = query.indexOf(" ");
    const name = sp === -1 ? query : query.slice(0, sp);
    const args = sp === -1 ? "" : query.slice(sp + 1).trim();
    return { kind: "command", name, args };
  }
  return { kind: "agent", query };
}
