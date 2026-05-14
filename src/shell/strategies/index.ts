import { zshStrategy } from "./zsh.js";
import { bashStrategy } from "./bash.js";
import type { ShellStrategy } from "./types.js";

export type { ShellStrategy, PrepareSpawnOpts, ShellSpawnConfig } from "./types.js";

const STRATEGIES: ShellStrategy[] = [zshStrategy, bashStrategy];

/** Strategy used when the requested shell isn't recognized. */
export const FALLBACK_STRATEGY: ShellStrategy = bashStrategy;

/** Names of supported shells, used for warning messages. */
export const SUPPORTED_SHELL_NAMES: readonly string[] = STRATEGIES.map((s) => s.name);

/**
 * Pick the strategy that matches the given shell binary path. Returns null
 * when no strategy claims the path — caller decides whether to warn and how
 * to fall back (e.g. shell.ts swaps the binary to /bin/bash; env capture
 * just runs the fallback strategy's syntax against the original binary).
 */
export function pickStrategy(shellPath: string): ShellStrategy | null {
  return STRATEGIES.find((s) => s.matches(shellPath)) ?? null;
}
