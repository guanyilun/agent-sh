/**
 * Shared token-budget constants used by auto-compaction.
 *
 * RESPONSE_RESERVE: tokens reserved for the model's output.
 * DEFAULT_CONTEXT_WINDOW: fallback when the active mode doesn't declare one.
 */

/** Response reserve — tokens reserved for the model's output. */
export const RESPONSE_RESERVE = 8192;

const FALLBACK_CONTEXT_WINDOW = 60_000;

export function resolveDefaultContextWindow(
  env: Record<string, string | undefined> = process.env,
): number {
  const n = Number(env.AGENT_SH_DEFAULT_CONTEXT_WINDOW);
  return Number.isInteger(n) && n > 0 ? n : FALLBACK_CONTEXT_WINDOW;
}

/** Fallback when contextWindow is unknown. */
export const DEFAULT_CONTEXT_WINDOW = resolveDefaultContextWindow();
