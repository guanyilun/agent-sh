/**
 * Per-shell adapter for the bits of agent-sh that are inherently shell-syntax
 * specific: rc-file generation, spawn args/env, env-capture command, and the
 * escape sequence used to repaint the prompt in place.
 *
 * Everything else (PTY I/O, OSC parsing, mute scopes, prompt boundary
 * detection) is shell-agnostic and lives in shell.ts / output-parser.ts.
 */

export interface PrepareSpawnOpts {
  /** Root for mkdtemp — typically os.tmpdir(). */
  tmpDirRoot: string;
  /** Per-instance tag (e.g. "id=abc123") so nested agent-sh hooks don't cross-trigger. */
  instanceTag: string;
  /** Whether to emit the terminal title indicator from the prompt hook. */
  showIndicator: boolean;
  /** Resolved user home (env.HOME ?? os.homedir()). */
  userHome: string;
  /** Inherited env at spawn time — strategies may read ZDOTDIR etc. */
  env: Record<string, string>;
}

export interface ShellSpawnConfig {
  /** Args to pass to pty.spawn after the shell binary. */
  args: string[];
  /** Env vars the strategy needs to set on the child (e.g. ZDOTDIR, XDG_CONFIG_HOME). */
  envOverrides: Record<string, string>;
  /** Temp directory the strategy created, if any — caller cleans up on exit. */
  tmpDir?: string;
}

export interface ShellStrategy {
  /** Short name used for fallback warnings ("zsh", "bash", "fish"). */
  readonly name: string;

  /** Does this strategy claim the binary at `shellPath`? */
  matches(shellPath: string): boolean;

  /**
   * Generate any rc files and return spawn args + env overrides. May create
   * a tmp directory; caller is responsible for cleanup via the returned path.
   */
  prepareSpawn(opts: PrepareSpawnOpts): ShellSpawnConfig;

  /**
   * Shell-syntax command run via `<shell> -l -c "<cmd>"` to source the user's
   * config and dump env. Used at startup to inherit shell-only env vars.
   */
  envCaptureCommand(): string;

  /**
   * Escape sequence to write to the PTY to ask the shell to repaint its
   * prompt in place. The corresponding binding is set up in prepareSpawn.
   * Returns null if the shell can't redraw — caller falls back to freshPrompt.
   */
  redrawEscape(): string | null;
}
