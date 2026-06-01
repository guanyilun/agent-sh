import type { ExtensionContext } from "agent-sh/types";
import type { MultiSessionStore } from "./multi-session-store.js";
import type { AgentShMessage as AgentMessage } from "agent-sh/session-store";

interface DiffEntry { diff: unknown; filePath: string }
export interface NestedDiff extends DiffEntry { name: string }

// liveEntryIds is parallel to the live messages array; null slots are synthetics (e.g. compaction summaries) with no entry.
export interface Capture {
  flush(): Promise<void>;
  getEntryIdAt(messageIndex: number): string | null;
  resetTo(ids: (string | null)[]): void;
}

export function registerCapture(
  ctx: ExtensionContext,
  getStore: () => MultiSessionStore,
): Capture {
  let liveEntryIds: (string | null)[] = [];
  // A bridged tool call re-emitted under a synthetic id has no conversation message
  // of its own, so bucket its diff under the enclosing real call for replay as a
  // separate edit pair.
  const diffMeta = new Map<string, DiffEntry>();
  const nestedDiffs = new Map<string, NestedDiff[]>();
  const summaryMeta = new Map<string, string>();
  const bridgedNames = new Map<string, string>();
  let activeRealToolId: string | undefined;

  // `nested` is a bridge-set bus convention (a host tool run inside another tool),
  // not on the core event type — read it defensively.
  const isNested = (e: unknown): boolean => !!(e as { nested?: boolean }).nested;

  ctx.bus.on("agent:tool-started", (e) => {
    const id = e.toolCallId;
    if (!id) return;
    if (isNested(e)) bridgedNames.set(id, e.name ?? e.title);
    else activeRealToolId = id;
  });

  ctx.bus.on("agent:tool-completed", (e) => {
    const id = e.toolCallId;
    if (!id) return;
    const display = e.resultDisplay;
    const body = display?.body;
    if (isNested(e)) {
      if (body?.kind === "diff" && activeRealToolId) {
        const arr = nestedDiffs.get(activeRealToolId) ?? [];
        arr.push({ name: bridgedNames.get(id) ?? "edit_file", diff: body.diff, filePath: body.filePath });
        nestedDiffs.set(activeRealToolId, arr);
      }
      return;
    }
    // resultDisplay isn't persisted; capture the summary for every tool so resume
    // doesn't fall back to re-deriving only a handful.
    if (typeof display?.summary === "string" && display.summary) summaryMeta.set(id, display.summary);
    if (body?.kind === "diff") diffMeta.set(id, { diff: body.diff, filePath: body.filePath });
  });

  const enrich = (m: AgentMessage): AgentMessage => {
    if (m.role !== "tool" || !m.tool_call_id) return m;
    const single = diffMeta.get(m.tool_call_id);
    const nested = nestedDiffs.get(m.tool_call_id);
    const summary = summaryMeta.get(m.tool_call_id);
    if (!single && !nested && !summary) return m;
    const meta: Record<string, unknown> = { ...m.meta };
    if (single) { meta.diff = single.diff; meta.filePath = single.filePath; }
    if (nested) meta.diffs = nested;
    if (summary) meta.summary = summary;
    return { ...m, meta };
  };

  const writeNewMessages = async (): Promise<void> => {
    const messages = ctx.call("conversation:get-messages") as AgentMessage[] | undefined;
    if (!messages || messages.length <= liveEntryIds.length) return;
    const newMessages = messages.slice(liveEntryIds.length).map(enrich);
    const newIds = await getStore().current().appendMessages(newMessages);
    liveEntryIds = [...liveEntryIds, ...newIds];
    getStore().markLastSession();
  };

  // Serialize flushes so an exit-time flush can't race processing-done and double-append.
  let chain: Promise<void> = Promise.resolve();
  const flush = (): Promise<void> => {
    chain = chain.then(writeNewMessages, writeNewMessages);
    return chain;
  };

  ctx.bus.on("agent:processing-done", () => { void flush(); });

  return {
    flush,
    getEntryIdAt: (i) => liveEntryIds[i] ?? null,
    resetTo: (ids) => { liveEntryIds = [...ids]; },
  };
}
