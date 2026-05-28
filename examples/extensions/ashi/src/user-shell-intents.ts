/** Pending intents for ashi-issued shell pty-writes. shell:command-start fires
 *  for any OSC 9997 — orphans (bash DEBUG-trap noise) are dropped on consume. */
export interface UserShellIntent {
  private: boolean;
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
