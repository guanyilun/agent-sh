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
  // Sticky: exit only via the Backspace-on-empty intercept. Auto-exit on
  // empty text would fire during pi-tui's pre-emptive onChange("") in
  // Editor.submitValue() and misroute the submit.
  return { mode };
}

export interface ChangeHandlerResult extends ShellModeTransition {
  /** Whether the next submit (if in shell mode) is marked private. */
  pendingPrivate: boolean;
}

/** Strips `!` (entry), `!!` (entry + private), in-mode `!` (upgrade to private).
 *  pendingPrivate is sticky while in shell mode — clearing on empty text would
 *  fire during the entry-strip's recursive onChange("") and lose the signal. */
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
