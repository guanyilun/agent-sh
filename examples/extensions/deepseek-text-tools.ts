/**
 * Recovers DeepSeek-style text-format tool calls (`name{...}` in
 * assistant content) when a provider drops structured tool_calls.
 * Opt-in via DEEPSEEK_TEXT_FALLBACK=1. Skips fenced code to avoid
 * dispatching examples the model is discussing.
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
        if (native.length > 0 || !args.text) return native;

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

function parseTextCalls(
  text: string,
  toolNames: Set<string>,
  nextId: () => number,
): PendingToolCall[] {
  // Blank out fenced code regions — length-preserving so match indices
  // into the masked string stay valid against the original.
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
    try {
      const parsed = JSON.parse(masked.slice(braceStart, end + 1));
      if (typeof parsed !== "object" || parsed === null) continue;
      calls.push({
        id: `ds_text_${nextId()}`,
        name,
        argumentsJson: JSON.stringify(parsed),
      });
    } catch {
      // keep scanning
    }
    re.lastIndex = end + 1;
  }
  return calls;
}

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
