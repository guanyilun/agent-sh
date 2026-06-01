import type { ExtensionContext } from "agent-sh/types";
import type { MultiSessionStore } from "./multi-session-store.js";
import type { AgentShMessage as AgentMessage } from "agent-sh/session-store";

interface DiffEntry { diff: unknown; filePath: string }
/** A scheme-bridged edit, replayed as its own edit pair; `name` picks the render model. */
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
  // Direct edits carry their diff on their own tool result. Scheme-bridged edits
  // run inside scheme_eval and are re-emitted under synthetic `scheme-*` ids with
  // no conversation message of their own, so their diffs are bucketed under the
  // enclosing real call and persisted there for replay as separate edit pairs.
  const diffMeta = new Map<string, DiffEntry>();
  const nestedDiffs = new Map<string, NestedDiff[]>();
  const bridgedNames = new Map<string, string>();
  let activeRealToolId: string | undefined;

  ctx.bus.on("agent:tool-started", (e) => {
    const id = e.toolCallId;
    if (!id) return;
    if (id.startsWith("scheme-")) bridgedNames.set(id, e.name ?? e.title);
    else activeRealToolId = id;
  });

  ctx.bus.on("agent:tool-completed", (e) => {
    const id = e.toolCallId;
    const body = e.resultDisplay?.body;
    if (!id || body?.kind !== "diff") return;
    if (id.startsWith("scheme-")) {
      if (!activeRealToolId) return;
      const arr = nestedDiffs.get(activeRealToolId) ?? [];
      arr.push({ name: bridgedNames.get(id) ?? "edit_file", diff: body.diff, filePath: body.filePath });
      nestedDiffs.set(activeRealToolId, arr);
    } else {
      diffMeta.set(id, { diff: body.diff, filePath: body.filePath });
    }
  });

  const enrich = (m: AgentMessage): AgentMessage => {
    if (m.role !== "tool" || !m.tool_call_id) return m;
    const single = diffMeta.get(m.tool_call_id);
    const nested = nestedDiffs.get(m.tool_call_id);
    if (!single && !nested) return m;
    const meta: Record<string, unknown> = { ...m.meta };
    if (single) { meta.diff = single.diff; meta.filePath = single.filePath; }
    if (nested) meta.diffs = nested;
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
