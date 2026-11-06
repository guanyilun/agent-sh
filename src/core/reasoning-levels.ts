/** Thinking levels, weakest first. "off" asks for no reasoning; a reasoning
 *  hook translates it (e.g. "none", "minimal", or the provider default). */
export const REASONING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** Offered when a model declares no levels (legacy ladder). */
export const DEFAULT_REASONING_LEVELS = ["off", "low", "medium", "high", "xhigh"];

const rank = (level: string): number => (REASONING_LEVELS as readonly string[]).indexOf(level);

/** Known levels only, deduplicated, weakest first; undefined when none remain. */
export function normalizeReasoningLevels(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const known = REASONING_LEVELS.filter((l) => raw.includes(l));
  return known.length ? [...known] : undefined;
}

/** The level actually sent for a preference. Undeclared models get the
 *  preference as is. "off" passes through even when not declared, so a model
 *  that can't disable reasoning keeps its provider default. Otherwise the
 *  nearest declared level wins, ties going up (DeepSeek maps xhigh to max). */
export function effectiveReasoningLevel(preferred: string, declared: string[] | undefined): string {
  if (!declared?.length || declared.includes(preferred) || preferred === "off") return preferred;
  const want = rank(preferred);
  if (want < 0) return declared[declared.length - 1]!;
  let best = declared[0]!;
  for (const level of declared) {
    const d = Math.abs(rank(level) - want);
    const bestD = Math.abs(rank(best) - want);
    if (d < bestD || (d === bestD && rank(level) > rank(best))) best = level;
  }
  return best;
}
