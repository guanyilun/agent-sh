/** Pending intents for ashi-issued shell pty-writes. shell:command-start fires
 *  for any OSC 9997 — orphans (bash DEBUG-trap noise) are dropped on consume.
 *  Carries the command ashi sent so the rendered label is the exact text we
 *  wrote to the pty, not whatever the shell echoes back. */
export interface UserShellIntent {
  private: boolean;
  command: string;
}

export class UserShellIntents {
  private q: UserShellIntent[] = [];

  push(intent: UserShellIntent): void {
    this.q.push(intent);
  }

  consume(): UserShellIntent | null {
    return this.q.shift() ?? null;
  }
}
