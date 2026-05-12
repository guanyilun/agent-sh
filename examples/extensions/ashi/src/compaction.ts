import type { ExtensionContext } from "agent-sh/types";
import type { NuclearEntry } from "agent-sh/core";
import type { TreeHistoryAdapter } from "./tree-history.js";

/** Pi-style LLM-driven compaction.
 *
 *  Advises `conversation:compact` to summarize older messages into a
 *  structured block and append the summary as a `compaction` NuclearEntry
 *  in the tree — instead of agent-sh's default "replace evicted turns with
 *  pre-computed nuclear one-liners" path. On auto-trigger, the kernel
 *  still decides *when* to compact; we replace *how*.
 *
 *  v0 scope: live compaction only. Restart fidelity (reloading the
 *  [summary, kept messages] shape from disk) is deferred — current tree
 *  storage doesn't persist raw AgentMessages per entry.
 */
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

interface AgentMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: unknown;
  tool_calls?: Array<{ function?: { name: string; arguments: string } }>;
}

export function registerCompaction(ctx: ExtensionContext, tree: TreeHistoryAdapter): void {
  ctx.advise("conversation:compact", async (next: (...a: unknown[]) => unknown, opts: unknown) => {
    if (!ctx.llm.available) return next(opts);

    const messages = ctx.call("conversation:get-messages") as AgentMessage[] | undefined;
    if (!messages || messages.length < 6) return next(opts);

    const cutIdx = findCutPoint(messages, KEEP_RECENT_TOKEN_BUDGET);
    if (cutIdx < 2) return next(opts);

    const older = messages.slice(0, cutIdx);
    const kept = messages.slice(cutIdx);

    const branch = await tree.getBranch(tree.getActiveLeaf());
    const prevSummary = [...branch].reverse().find((e) => e.kind === "compaction")?.body;

    const tokensBefore = (ctx.call("conversation:estimate-prompt-tokens") as number) ?? 0;

    let summary: string;
    try {
      summary = await ctx.llm.ask({
        system: SUMMARY_PROMPT,
        query: buildQuery(older, prevSummary),
        maxTokens: 4096,
        reasoningEffort: "low",
      });
    } catch (e) {
      ctx.bus.emit("ui:error", { message: `compaction: LLM failed (${(e as Error).message}); falling back to two-tier-pin` });
      return next(opts);
    }

    const summaryMessage: AgentMessage = {
      role: "user",
      content: `[Compacted conversation summary]\n${summary.trim()}`,
    };
    ctx.call("conversation:replace-messages", [summaryMessage, ...kept]);

    const seq = ctx.call("conversation:allocate-seq") as number;
    const entry: NuclearEntry = {
      seq,
      ts: Date.now(),
      iid: ctx.instanceId,
      kind: "compaction",
      sum: `compacted ${older.length} messages (${tokensBefore} → ~${estimateTokens(summary)} tokens)`,
      body: summary,
    };
    ctx.call("history:append", [entry]);

    const tokensAfter = (ctx.call("conversation:estimate-prompt-tokens") as number) ?? 0;
    ctx.bus.emit("ui:info", { message: `compacted ${older.length} messages: ${tokensBefore} → ${tokensAfter} tokens` });

    return { before: tokensBefore, after: tokensAfter, evictedCount: older.length };
  });
}

/** Find the index such that messages[cutIdx..] is ≤ tokenBudget tokens
 *  AND messages[cutIdx] is a safe cut point (not a tool result; not in
 *  the middle of an assistant→tool call/result group). Walks backwards
 *  from the end. */
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
  if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) return false;
  return true;
}

function estimateMessageTokens(m: AgentMessage): number {
  let chars = 0;
  if (typeof m.content === "string") chars += m.content.length;
  if (m.tool_calls) for (const tc of m.tool_calls) chars += (tc.function?.arguments?.length ?? 0);
  return Math.ceil(chars * APPROX_TOKENS_PER_CHAR) + 20;
}

function estimateTokens(s: string): number {
  return Math.ceil(s.length * APPROX_TOKENS_PER_CHAR);
}

/** Pi-style conversation serialization. Tool results truncated to 2000
 *  chars; keeps role labels so the model doesn't try to continue the
 *  conversation. */
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
        for (const tc of m.tool_calls) {
          const args = tc.function?.arguments ?? "";
          lines.push(`[Assistant tool call]: ${tc.function?.name ?? "?"}(${truncate(args, 400)})`);
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
