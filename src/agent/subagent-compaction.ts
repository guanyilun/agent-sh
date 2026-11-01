/** Compaction for one long subagent run. rolling-history cuts at user turns, and
 *  a subagent run is a single turn, so this works within it in two stages:
 *  1. clear the oldest tool results (recoverable by re-running the tool);
 *  2. if still over target, cut the middle of the run as ashi does, keeping the
 *     task and the most recent messages. No model call. */
import type { HostExtension } from "../runtime/index.js";
import type { ExtensionContext } from "../shell/host-types.js";
import type { ChatCompletionMessageParam } from "./llm-client.js";
import { estimateMessagesTokens } from "../utils/token-estimate.js";

type Message = ChatCompletionMessageParam;

export const CLEARED = "[earlier tool output cleared to fit the context window";
export const REMOVED = "[earlier steps of this run were removed to fit the context window";
const KEEP_RECENT_RESULTS = 4;
const MIN_KEEP_TOKENS = 4_000;

export interface SubagentCompactionOptions {
  /** Messages before the task (the run's `history`); the task message follows them. */
  historyLength?: number;
  keepRecentResults?: number;
}

const text = (m: Message) => typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");

/** Stage 1: stub out old tool results, oldest first, until `tokens` reaches `target`. */
export function clearToolResults(msgs: Message[], tokens: number, target: number, keepRecent: number) {
  const out = [...msgs];
  const toolIdx = msgs.flatMap((m, i) => m.role === "tool" ? [i] : []);
  let cleared = 0;
  for (const i of toolIdx.slice(0, Math.max(0, toolIdx.length - keepRecent))) {
    if (tokens <= target) break;
    const m = msgs[i]!;
    const body = text(m);
    if (body.startsWith(CLEARED) || body.length < 400) continue;
    const stub = { ...m, content: `${CLEARED} (${body.length} chars); re-run the tool if you need it]` } as Message;
    tokens -= estimateMessagesTokens([m]) - estimateMessagesTokens([stub]);
    out[i] = stub;
    cleared++;
  }
  return { messages: out, tokens, cleared };
}

/** First index to keep so the kept tail fits `budget`; never a tool result,
 *  whose assistant call would be cut away. */
export function findCut(msgs: Message[], from: number, budget: number): number {
  let acc = 0;
  let i = msgs.length;
  while (i > from && acc + estimateMessagesTokens([msgs[i - 1]!]) <= budget) acc += estimateMessagesTokens([msgs[--i]!]);
  while (i < msgs.length && msgs[i]!.role === "tool") i++;
  return i;
}

export function subagentCompaction(options: SubagentCompactionOptions = {}): HostExtension {
  const keepRecent = options.keepRecentResults ?? KEEP_RECENT_RESULTS;
  return {
    name: "subagent-compaction",
    activate(ctx: ExtensionContext) {
      ctx.advise("conversation:compact", (next: (o: unknown) => unknown, opts: {
        target?: number; force?: boolean; strategy?: { kind: string };
      } = {}) => {
        if (opts.strategy) return next(opts);
        const before = ctx.call("conversation:estimate-prompt-tokens") as number;
        const overhead = Math.max(0, before - (ctx.call("conversation:estimate-tokens") as number));
        const target = opts.target ?? 0;
        if (!opts.force && before <= target) return null;

        const msgs = ctx.call("conversation:get-messages") as Message[];
        const stage1 = clearToolResults(msgs, before, target, keepRecent);
        let out = stage1.messages;
        let evicted = stage1.cleared;

        if (stage1.tokens > target) {
          const history = options.historyLength ?? 0;
          const taskIdx = out.findIndex((m, i) => i >= history && m.role === "user");
          if (taskIdx >= 0) {
            const convTarget = Math.max(0, target - overhead);
            const cut = findCut(out, taskIdx + 1, Math.max(MIN_KEEP_TOKENS, Math.floor(convTarget * 0.6)));
            // A previous marker in the cut span is folded into the new one.
            const middle = out.slice(taskIdx + 1, cut).filter(m => !(m.role === "user" && text(m).startsWith(REMOVED)));
            if (middle.length >= 2) {
              const note = `${REMOVED}; continue from the recent steps below and re-check state before relying on earlier ones]`;
              out = [...out.slice(0, taskIdx + 1), { role: "user", content: note }, ...out.slice(cut)];
              evicted += middle.length;
            }
          }
        }

        if (evicted === 0) return null;
        ctx.call("conversation:replace-messages", out);
        return { before, after: ctx.call("conversation:estimate-prompt-tokens") as number, evictedCount: evicted };
      });
    },
  };
}
