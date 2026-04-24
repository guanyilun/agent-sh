/**
 * DeepSeek text-format tool-call fallback.
 *
 * DeepSeek v3.x/v4-flash deterministically collapse from structured
 * tool_calls to text `name{"arg":...}` format at larger request shapes
 * (long system prompts, many tools, deep history). When that happens,
 * core sees assistant text with zero tool_calls and dispatches nothing.
 *
 * This extension advises tool-protocol:extract-calls. It runs core's
 * parser first; if zero tool_calls came back AND the streamed text
 * contains `name{jsonish}` patterns matching registered tool names, it
 * parses them out and returns synthetic PendingToolCalls so the agent
 * loop can dispatch them normally.
 *
 * Trade-offs:
 *  - False positives: the model might *discuss* a call (e.g. inside a
 *    code block) without meaning to execute. Mitigated by requiring the
 *    function name to match a registered tool, JSON to parse cleanly,
 *    and the text to not be a recognizable code fence.
 *  - Gated on `DEEPSEEK_TEXT_FALLBACK` env or settings flag so it
 *    doesn't silently alter behavior for providers that are well-
 *    behaved.
 */
import type { ExtensionContext } from "agent-sh/types";

interface PendingToolCall {
  id: string;
  name: string;
  argumentsJson: string;
}

export default function activate(ctx: ExtensionContext): void {
  const enabled = process.env.DEEPSEEK_TEXT_FALLBACK === "1";
  if (!enabled) return;

  let counter = 0;

  ctx.advise(
    "tool-protocol:extract-calls",
    (next: (args: unknown) => PendingToolCall[]) =>
      (args: { text: string; streamedCalls: PendingToolCall[] }) => {
        const native = next(args);
        if (native.length > 0) return native;          // core/protocol already got it
        if (!args.text) return native;

        const toolNames = new Set(
          (ctx.getTools?.() ?? []).map((t) => t.name),
        );
        if (toolNames.size === 0) return native;

        const synthetic = parseTextCalls(args.text, toolNames, () => ++counter);
        if (synthetic.length === 0) return native;

        ctx.bus.emit("ui:info", {
          message:
            `[deepseek-text-fallback] recovered ${synthetic.length} tool call(s) ` +
            `from text: ${synthetic.map((c) => c.name).join(", ")}`,
        });
        return synthetic;
      },
  );
}

/**
 * Find `name({...})` patterns where `name` is a registered tool and the
 * `{...}` body parses as JSON. Skips matches inside triple-backtick code
 * blocks to avoid grabbing examples the model is *discussing*.
 */
function parseTextCalls(
  text: string,
  toolNames: Set<string>,
  nextId: () => number,
): PendingToolCall[] {
  // Blank out fenced code regions so their contents don't match.
  const masked = text.replace(/```[\s\S]*?```/g, (m) => " ".repeat(m.length));

  const calls: PendingToolCall[] = [];
  const re = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked)) !== null) {
    const name = m[1]!;
    if (!toolNames.has(name)) continue;
    const braceStart = m.index + m[0].length - 1;
    const end = findMatchingBrace(masked, braceStart);
    if (end === -1) continue;
    const body = masked.slice(braceStart, end + 1);
    try {
      // Round-trip to validate + normalize; the arguments field must be
      // a valid JSON string per the OpenAI tool-call contract.
      const parsed = JSON.parse(body);
      if (typeof parsed !== "object" || parsed === null) continue;
      calls.push({
        id: `ds_text_${nextId()}`,
        name,
        argumentsJson: JSON.stringify(parsed),
      });
    } catch {
      // unparseable — skip, keep scanning
    }
    re.lastIndex = end + 1;
  }
  return calls;
}

/**
 * Balanced-brace scanner respecting string literals + escapes.
 * Returns the index of the `}` that matches `text[start]`, or -1.
 */
function findMatchingBrace(text: string, start: number): number {
  let depth = 0;
  let inStr = false;
  let quote = "";
  for (let i = start; i < text.length; i++) {
    const c = text[i]!;
    if (inStr) {
      if (c === "\\") { i++; continue; }
      if (c === quote) inStr = false;
      continue;
    }
    if (c === '"' || c === "'") { inStr = true; quote = c; continue; }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}
