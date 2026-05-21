import type { Store, Entry } from "../../store.js";
import type { LiveView } from "../../live-view.js";
import { newEntryId } from "../../store.js";
import type { AgentShMessage } from "../../llm-client.js";
import {
  type NuclearEntry,
  nucleate,
  READ_ONLY_TOOLS,
  WRITE_TOOLS,
  isReadOnly,
} from "../../nuclear-form.js";
import { formatEntryLine } from "../../entry-format.js";
import { SUMMARY_STORE, RECALL_CACHE_KIND } from "./constants.js";

interface ToolMeta {
  toolName: string;
  args: Record<string, unknown>;
  isError?: boolean;
}

export interface SummaryCtx {
  liveView: LiveView;
  store(name: string): Store;
  bus: {
    on(event: "conversation:message-appended", fn: MessageAppendedHandler): void;
  };
  advise(
    op: "conversation:compact",
    fn: CompactAdvisor,
  ): void;
  /** Process id — disambiguates cross-instance entries in `nucleate()`. */
  iid: string;
}

export interface MessageAppendedEvent {
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  isError?: boolean;
}
export type MessageAppendedHandler = (e: MessageAppendedEvent) => Promise<void> | void;

export interface CompactEvent {
  target?: number;
  force?: boolean;
  /** `rewind`/`replace` are kernel-owned manual edits — the summary
   *  strategy delegates them via `next()`. */
  strategy?:
    | { kind: "two-tier-pin"; target: number; keepRecent?: number; force?: boolean }
    | { kind: "rewind"; toIndex: number }
    | { kind: "replace"; messages: unknown[] };
}
export interface CompactResult {
  before: number;
  after: number;
  evictedCount: number;
}
export type CompactAdvisor = (
  next: (e: CompactEvent) => Promise<CompactResult | null>,
  event: CompactEvent,
) => Promise<CompactResult | null>;

export function activate(ctx: SummaryCtx): void {
  ctx.bus.on("conversation:message-appended", makeCaptureHandler(ctx));
  ctx.advise("conversation:compact", makeCompactAdvisor(ctx));
}

export function makeCaptureHandler(ctx: SummaryCtx): MessageAppendedHandler {
  return async (e) => {
    const store = ctx.store(SUMMARY_STORE);
    // Capture the index synchronously — later async ticks may grow the array.
    const msgs = ctx.liveView.get();
    const liveIdx = msgs.length - 1;
    const m = msgs[liveIdx];
    if (!m) return;

    // Stamp meta.tool so compact's inferPriority can read it without
    // walking back to the event payload.
    if (e.role === "tool" && e.toolName !== undefined) {
      m.meta = {
        ...m.meta,
        tool: { toolName: e.toolName, args: e.toolArgs ?? {}, isError: !!e.isError },
      };
    }

    const ne = nucleateFromEvent(e, ctx.iid);
    if (!ne) return;
    const id = newEntryId();
    await store.append([nuclearToEntry(ne, id)]);
    await store.append(
      [{
        id: newEntryId(), parentId: id, ts: Date.now(),
        kind: RECALL_CACHE_KIND,
        payload: { fullMessage: m },
      }],
      { ephemeral: true },
    );
    ctx.liveView.link(liveIdx, id);
  };
}

function nucleateFromEvent(e: MessageAppendedEvent, iid: string): NuclearEntry | null {
  if (e.role === "user") {
    if (!e.content) return null;
    return nucleate("user", e.content, iid, 0);
  }
  if (e.role === "assistant") {
    if (!e.content) return null;
    return nucleate("agent", e.content, iid, 0);
  }
  if (e.role === "tool") {
    if (e.toolName === undefined) return null;
    return nucleate("tool", e.toolName, e.toolArgs ?? {}, e.content, !!e.isError, iid, 0);
  }
  return null;
}

/** Used during compact when topping up summaries for messages that
 *  missed eager capture (e.g. injected system notes that bypassed the
 *  event). Reads from message structure rather than an event payload. */
function nucleateFromMessage(m: AgentShMessage, iid: string): NuclearEntry | null {
  if (m.role === "user") {
    const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
    if (!text) return null;
    return nucleate("user", text, iid, 0);
  }
  if (m.role === "assistant") {
    if ("tool_calls" in m && m.tool_calls && m.tool_calls.length > 0) return null;
    const text = typeof m.content === "string" ? m.content : "";
    if (!text) return null;
    return nucleate("agent", text, iid, 0);
  }
  if (m.role === "tool") {
    const tool = m.meta?.tool as ToolMeta | undefined;
    if (!tool) return null;
    const content = typeof m.content === "string" ? m.content : "";
    return nucleate("tool", tool.toolName, tool.args, content, tool.isError ?? false, iid, 0);
  }
  return null;
}

function nuclearToEntry(ne: NuclearEntry, id: string): Entry {
  const { seq: _seq, ts, kind, ...rest } = ne;
  return { id, ts, kind, payload: rest };
}

const DEFAULT_RECENT_TURNS_KEEP = 10;

export function makeCompactAdvisor(ctx: SummaryCtx): CompactAdvisor {
  return async (next, event) => {
    if (event.strategy?.kind === "rewind" || event.strategy?.kind === "replace") {
      return next(event);
    }
    const promptBefore = ctx.liveView.estimatePromptTokens();
    const convBefore = ctx.liveView.estimateTokens();
    const overhead = Math.max(0, promptBefore - convBefore);
    const promptTarget = event.target ?? Infinity;
    const convTarget = Math.max(0, promptTarget - overhead);

    if (!event.force && promptBefore <= promptTarget) return null;

    const msgs = ctx.liveView.get();
    const turns = parseTurns(msgs);
    const minTurns = event.force ? 1 : 2;
    if (turns.length <= minTurns) return null;

    const maxPinnedFraction = event.force ? 0.4 : 0.6;
    const maxPinned = Math.max(2, Math.floor(turns.length * maxPinnedFraction));
    const recentKeep = Math.min(
      DEFAULT_RECENT_TURNS_KEEP,
      turns.length - 1,
      Math.max(1, event.force ? Math.min(maxPinned, turns.length - 2) : maxPinned),
    );
    for (const t of turns) t.priority = inferPriority(t.messages);
    const verbatimCount = 1;
    const slimmedCount = Math.max(0, recentKeep - verbatimCount);
    const slimStart = turns.length - recentKeep;
    const slimEnd = slimStart + slimmedCount;
    const slimmedIndices = new Set<number>();
    for (let i = slimStart; i < slimEnd; i++) slimmedIndices.add(i);
    turns[0]!.priority = Priority.PINNED;
    for (let i = turns.length - verbatimCount; i < turns.length; i++) turns[i]!.priority = Priority.PINNED;
    for (const i of slimmedIndices) turns[i]!.priority = Priority.PINNED;

    const candidates = turns
      .map((t, idx) => ({ turn: t, idx }))
      .filter((c) => c.turn.priority !== Priority.PINNED)
      .sort((a, b) => {
        const wA = a.turn.priority * recencyWeight(a.idx, turns.length);
        const wB = b.turn.priority * recencyWeight(b.idx, turns.length);
        return wA - wB || a.idx - b.idx;
      });

    const evicted = new Set<number>();
    let tokens = convBefore;
    const newSummaryEntries: Entry[] = [];
    const newCacheEntries: Entry[] = [];
    const store = ctx.store(SUMMARY_STORE);

    for (const c of candidates) {
      if (tokens <= convTarget) break;
      evicted.add(c.idx);
      tokens -= estimateTurnTokens(c.turn.messages);

      // Top up summaries for messages that missed eager capture.
      // Read-only tools are cached ephemerally only — the agent can
      // re-read the source.
      for (const m of c.turn.messages) {
        const existingId = m.meta?.entryId as string | undefined;
        if (existingId) {
          newCacheEntries.push({
            id: newEntryId(), parentId: existingId, ts: Date.now(),
            kind: RECALL_CACHE_KIND,
            payload: { fullMessage: m },
          });
          continue;
        }
        const ne = nucleateFromMessage(m, ctx.iid);
        if (!ne) continue;
        const id = newEntryId();
        const entry = nuclearToEntry(ne, id);
        if (!isReadOnly(ne)) {
          newSummaryEntries.push(entry);
        }
        newCacheEntries.push({
          id: newEntryId(), parentId: id, ts: Date.now(),
          kind: RECALL_CACHE_KIND,
          payload: { fullMessage: m },
        });
      }
    }

    if (evicted.size === 0) return null;

    if (newSummaryEntries.length > 0) await store.append(newSummaryEntries);
    if (newCacheEntries.length > 0) await store.append(newCacheEntries, { ephemeral: true });

    const rebuilt: AgentShMessage[] = [];
    let blockInserted = false;
    for (let i = 0; i < turns.length; i++) {
      if (evicted.has(i)) {
        if (!blockInserted) {
          rebuilt.push(await buildSummaryBlock(store));
          blockInserted = true;
        }
        continue;
      }
      if (slimmedIndices.has(i)) {
        rebuilt.push(...slimTurn(turns[i]!.messages));
      } else {
        rebuilt.push(...turns[i]!.messages);
      }
    }

    ctx.liveView.replace(rebuilt);
    const after = ctx.liveView.estimatePromptTokens();
    return { before: promptBefore, after, evictedCount: evicted.size };
  };
}

export enum Priority {
  LOWEST = 0,   // large read-only tool results
  LOW = 1,      // successful tool results
  MEDIUM = 2,   // write/edit tool results, plain assistant turns
  HIGH = 3,     // user messages, errors
  PINNED = 4,   // never evicted
}

export interface Turn {
  messages: AgentShMessage[];
  priority: Priority;
}

/** A new turn starts at each user message; the first may be headless
 *  (system, preamble). */
export function parseTurns(msgs: AgentShMessage[]): Turn[] {
  const turns: Turn[] = [];
  let current: AgentShMessage[] = [];
  for (const m of msgs) {
    if (m.role === "user" && current.length > 0) {
      turns.push({ messages: current, priority: Priority.MEDIUM });
      current = [];
    }
    current.push(m);
  }
  if (current.length > 0) turns.push({ messages: current, priority: Priority.MEDIUM });
  return turns;
}

export function inferPriority(msgs: AgentShMessage[]): Priority {
  let hasError = false;
  let hasWriteTool = false;
  let allReadOnly = true;
  let hasToolResult = false;

  for (const m of msgs) {
    if (m.role === "user") return Priority.HIGH;
    if (m.role === "tool") {
      hasToolResult = true;
      const tool = m.meta?.tool as ToolMeta | undefined;
      const content = typeof m.content === "string" ? m.content : "";
      if (tool?.isError || content.startsWith("Error:")) hasError = true;
    }
    if (m.role === "assistant" && "tool_calls" in m && m.tool_calls) {
      for (const tc of m.tool_calls) {
        const fn = "function" in tc ? tc.function : undefined;
        if (!fn) continue;
        if (WRITE_TOOLS.has(fn.name)) hasWriteTool = true;
        if (!READ_ONLY_TOOLS.has(fn.name)) allReadOnly = false;
      }
    }
  }

  if (hasError) return Priority.HIGH;
  if (hasWriteTool) return Priority.MEDIUM;
  if (hasToolResult && allReadOnly) return Priority.LOWEST;
  if (hasToolResult) return Priority.LOW;
  return Priority.MEDIUM;
}

function recencyWeight(idx: number, total: number): number {
  return Math.max(0.1, 1 - idx / total);
}

function estimateTurnTokens(msgs: AgentShMessage[]): number {
  return Math.ceil(JSON.stringify(msgs).length / 4);
}

export function slimTurn(messages: AgentShMessage[]): AgentShMessage[] {
  const MAX_RESULT_LEN = 1500;
  const MAX_ASSISTANT_LEN = 1500;
  const result: AgentShMessage[] = [];
  const droppedToolIds = new Set<string>();

  for (const msg of messages) {
    if (msg.role === "assistant" && "tool_calls" in msg && msg.tool_calls) {
      const kept = msg.tool_calls.filter((tc) => {
        if (!("function" in tc)) return true;
        if (READ_ONLY_TOOLS.has(tc.function.name)) {
          droppedToolIds.add(tc.id);
          return false;
        }
        return true;
      });
      if (kept.length === 0) {
        const text = typeof msg.content === "string" ? msg.content.trim() : "";
        if (!text) continue;
        const { tool_calls: _tc, ...rest } = msg;
        result.push(rest as AgentShMessage);
      } else {
        result.push({ ...msg, tool_calls: kept });
      }
      continue;
    }
    if (msg.role === "tool") {
      if (droppedToolIds.has(msg.tool_call_id)) continue;
      const content = typeof msg.content === "string" ? msg.content : "";
      if (content.length > MAX_RESULT_LEN) {
        result.push({ ...msg, content: slimToolContent(content, MAX_RESULT_LEN) });
      } else {
        result.push(msg);
      }
      continue;
    }
    if (msg.role === "assistant" && typeof msg.content === "string" && msg.content.length > MAX_ASSISTANT_LEN) {
      const head = msg.content.slice(0, Math.floor(MAX_ASSISTANT_LEN * 0.6));
      const tail = msg.content.slice(-Math.floor(MAX_ASSISTANT_LEN * 0.2));
      const trimmed = msg.content.length - head.length - tail.length;
      result.push({ ...msg, content: `${head}\n... [${trimmed} chars trimmed by compact]\n${tail}` });
      continue;
    }
    result.push(msg);
  }
  return result;
}

function slimToolContent(content: string, maxLen: number): string {
  const exitMatch = content.match(/exit code:?\s*(\d+)/i);
  const exitSuffix = exitMatch ? ` (exit ${exitMatch[1]})` : "";
  const lines = content.split("\n");
  if (lines.length > 6) {
    const head = lines.slice(0, 3).join("\n");
    const tail = lines.slice(-2).join("\n");
    return `${head}\n... [${lines.length - 5} lines trimmed by compact]\n${tail}${exitSuffix}`;
  }
  return `${content.slice(0, maxLen)}\n... [${content.length - maxLen} chars trimmed by compact]${exitSuffix}`;
}

export async function readSummaryLines(store: Store, n?: number): Promise<string[]> {
  const recent = await store.readRecent(n);
  return recent.filter((e) => e.kind !== RECALL_CACHE_KIND).map(formatEntryLine);
}

async function buildSummaryBlock(store: Store): Promise<AgentShMessage> {
  const lines = await readSummaryLines(store);
  return {
    role: "user",
    content: `[Conversation history — use conversation_recall to expand any entry]\n${lines.join("\n")}`,
  };
}
