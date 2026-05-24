import type { ExtensionContext } from "agent-sh/types";
import type { MultiSessionStore } from "./multi-session-store.js";
import type { Capture } from "./capture.js";
import type { AgentMessage } from "./session-store.js";

const KEEP_RECENT_TOKEN_BUDGET = 20_000;
const APPROX_TOKENS_PER_CHAR = 0.25;

export function registerCompaction(
  ctx: ExtensionContext,
  getStore: () => MultiSessionStore,
  capture: Capture,
): void {
  ctx.define("ashi:compact:build-summary", (_evicted: AgentMessage[]): string | null => null);

  ctx.advise("conversation:compact", async (next: (...a: unknown[]) => unknown, opts: unknown) => {
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
    const tokensBefore = (ctx.call("conversation:estimate-prompt-tokens") as number) ?? 0;
    const customSummary = (await ctx.call("ashi:compact:build-summary", older)) as string | null | undefined;

    await getStore().current().appendCompaction(firstKeptId, tokensBefore, customSummary ?? undefined);

    ctx.call("conversation:replace-messages", getStore().current().buildMessages());

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
