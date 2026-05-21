import type { ExtensionContext } from "agent-sh/types";
import type { MultiSessionStore } from "./multi-session-store.js";
import type { Capture } from "./capture.js";
import type { AgentMessage, CompactionEntry } from "./session-store.js";

const KEEP_RECENT_TOKEN_BUDGET = 20_000;
const APPROX_TOKENS_PER_CHAR = 0.25;

const SUMMARY_PROMPT = `You are compacting a coding-agent conversation so the agent can continue with limited context.

Produce a Markdown summary using EXACTLY this structure:

## Goal
[What the user is trying to accomplish, one or two sentences]

## Constraints & Preferences
- [Bulleted user requirements / preferences expressed so far]

## Progress
### Done
- [x] [Completed work]

### In Progress
- [ ] [Active work and current sub-goal]

### Blocked
- [Issues, or "None"]

## Key Decisions
- **[Decision]**: [Rationale]

## Next Steps
1. [What should happen next]

## Critical Context
- [Specific paths, names, identifiers, or data the agent must remember]

Be concrete. Quote file paths, function names, error strings verbatim when relevant. Do not invent details that aren't in the conversation.`;

export function registerCompaction(
  ctx: ExtensionContext,
  getStore: () => MultiSessionStore,
  capture: Capture,
): void {
  ctx.advise("conversation:compact", async (next: (...a: unknown[]) => unknown, opts: unknown) => {
    const llm = ctx.agent?.llm;
    if (!llm?.available) return next(opts);

    await capture.flush();
    const messages = ctx.call("conversation:get-messages") as AgentMessage[] | undefined;
    if (!messages || messages.length < 6) return next(opts);

    const cutIdx = findCutPoint(messages, KEEP_RECENT_TOKEN_BUDGET);
    if (cutIdx < 2) return next(opts);

    const firstKeptId = capture.getEntryIdAt(cutIdx);
    if (!firstKeptId) {
      ctx.bus.emit("ui:error", { message: "compaction: kept-message has no on-disk entry; falling back" });
      return next(opts);
    }

    const older = messages.slice(0, cutIdx);
    const kept = messages.slice(cutIdx);

    const branch = await getStore().current().getBranch();
    const prevCompaction = [...branch].reverse().find((e) => e.type === "compaction") as CompactionEntry | undefined;
    const prevSummary = prevCompaction?.summary;

    const tokensBefore = (ctx.call("conversation:estimate-prompt-tokens") as number) ?? 0;

    let summary: string;
    try {
      summary = await llm.ask({
        system: SUMMARY_PROMPT,
        query: buildQuery(older, prevSummary),
        maxTokens: 16384,
        reasoningEffort: "low",
      });
    } catch (e) {
      ctx.bus.emit("ui:error", { message: `compaction: LLM failed (${(e as Error).message}); falling back` });
      return next(opts);
    }

    await getStore().current().appendCompaction(summary.trim(), firstKeptId, tokensBefore);

    const summaryMessage: AgentMessage = {
      role: "user",
      content: `[Compacted conversation summary]\n${summary.trim()}`,
    };
    ctx.call("conversation:replace-messages", [summaryMessage, ...kept]);

    const keptIds = kept.map((_, i) => capture.getEntryIdAt(cutIdx + i));
    if (keptIds.some((id) => id === null)) {
      ctx.bus.emit("ui:error", { message: "compaction: a kept message has no on-disk entry — capture invariant broken" });
    }
    capture.resetTo([null, ...keptIds]);

    const tokensAfter = (ctx.call("conversation:estimate-prompt-tokens") as number) ?? 0;
    ctx.bus.emit("ui:info", { message: `compacted ${older.length} messages: ${tokensBefore} → ${tokensAfter} tokens` });

    return { before: tokensBefore, after: tokensAfter, evictedCount: older.length };
  });
}

function findCutPoint(messages: AgentMessage[], tokenBudget: number): number {
  let acc = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    acc += estimateMessageTokens(messages[i]!);
    if (acc >= tokenBudget) {
      let cut = i;
      while (cut < messages.length && !isSafeCutPoint(messages, cut)) cut++;
      return cut;
    }
  }
  return 0;
}

function isSafeCutPoint(messages: AgentMessage[], idx: number): boolean {
  const m = messages[idx];
  if (!m) return true;
  if (m.role === "tool") return false;
  return !(m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0);
}

function estimateMessageTokens(m: AgentMessage): number {
  let chars = 0;
  if (typeof m.content === "string") chars += m.content.length;
  if (m.tool_calls) for (const t of m.tool_calls) chars += (t.function?.arguments?.length ?? 0);
  return Math.ceil(chars * APPROX_TOKENS_PER_CHAR) + 20;
}

function buildQuery(messages: AgentMessage[], prevSummary?: string): string {
  const lines: string[] = [];
  if (prevSummary) lines.push("Previous compaction summary (continue iteratively):\n", prevSummary, "\n---\n");
  lines.push("Conversation to summarize:");
  for (const m of messages) {
    const text = typeof m.content === "string" ? m.content : "";
    if (m.role === "user") lines.push(`[User]: ${text}`);
    else if (m.role === "assistant") {
      if (text) lines.push(`[Assistant]: ${text}`);
      if (m.tool_calls) {
        for (const t of m.tool_calls) {
          const args = t.function?.arguments ?? "";
          lines.push(`[Assistant tool call]: ${t.function?.name ?? "?"}(${truncate(args, 400)})`);
        }
      }
    } else if (m.role === "tool") {
      lines.push(`[Tool result]: ${truncate(text, 2000)}`);
    }
  }
  return lines.join("\n");
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n[…truncated ${s.length - max} chars…]`;
}
