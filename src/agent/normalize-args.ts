/**
 * Schema-aware tool-arg normalization.
 *
 * Some LLMs (notably Claude) occasionally emit nested object/array
 * tool-call arguments as JSON-encoded strings instead of native
 * objects, despite the schema declaring `type: "object"` /
 * `type: "array"`. The discrepancy was diagnosed by the superash field
 * test (2026-05-03 / commit `b9efd47`):
 *
 *     describe_demos: 'task' arrived as a string (length 1267)
 *       last char code: 93 (']')
 *       truncation suspected: true
 *
 * Tool handlers downstream had to add ad-hoc JSON.parse fallbacks. This
 * helper centralizes the fix at the kernel boundary: after parsing the
 * outer `argumentsJson`, walk each top-level field; for any field whose
 * schema declares `object` or `array` but whose value is a string, run
 * a single JSON.parse pass. On parse failure (e.g. truncated content),
 * the string is left as-is — the tool can produce a clean error.
 *
 * Top-level only by design. Recursing into nested object schemas would
 * change semantics for tools that legitimately accept stringified
 * payloads as inner fields, and the observed wild cases all stringify
 * at the top level.
 */

/** Subset of a JSON Schema root we care about: `properties` keyed by
 *  field name, each declaring a `type`. Anything else is ignored. */
type ToolInputSchema = {
  properties?: Record<string, { type?: string } | unknown>;
  [k: string]: unknown;
};

/** Normalize tool-call args against the tool's input_schema. Pure: does
 *  not mutate `args`. Returns a new object with stringified-then-decoded
 *  fields swapped in where applicable. */
export function normalizeToolArgs(
  args: Record<string, unknown>,
  schema: unknown,
): Record<string, unknown> {
  if (!schema || typeof schema !== "object") return args;
  const properties = (schema as ToolInputSchema).properties;
  if (!properties || typeof properties !== "object") return args;

  let out: Record<string, unknown> | null = null;
  for (const [field, fieldSchema] of Object.entries(properties)) {
    if (!fieldSchema || typeof fieldSchema !== "object") continue;
    const expectedType = (fieldSchema as { type?: unknown }).type;
    if (expectedType !== "object" && expectedType !== "array") continue;
    const value = args[field];
    if (typeof value !== "string") continue;
    try {
      const parsed = JSON.parse(value);
      if (out === null) out = { ...args };
      out[field] = parsed;
    } catch {
      // Leave as string — downstream tool can produce a useful error.
    }
  }
  return out ?? args;
}
