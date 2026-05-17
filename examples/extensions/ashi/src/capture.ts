import type { ExtensionContext } from "agent-sh/types";
import type { MultiSessionStore } from "./multi-session-store.js";
import type { AgentMessage } from "./session-store.js";

/** Maintains an `(entryId | null)[]` parallel to the live messages array;
 *  null slots are synthetics like compaction summaries that have no entry. */
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
  const diffMeta = new Map<string, { diff: unknown; filePath: string }>();

  ctx.bus.on("agent:tool-completed", (e) => {
    const id = e.toolCallId;
    const body = e.resultDisplay?.body;
    if (id && body?.kind === "diff") {
      diffMeta.set(id, { diff: body.diff, filePath: body.filePath });
    }
  });

  const enrich = (m: AgentMessage): AgentMessage => {
    if (m.role !== "tool" || !m.tool_call_id) return m;
    const meta = diffMeta.get(m.tool_call_id);
    if (!meta) return m;
    return { ...m, meta: { ...m.meta, diff: meta.diff, filePath: meta.filePath } };
  };

  const flush = async (): Promise<void> => {
    const messages = ctx.call("conversation:get-messages") as AgentMessage[] | undefined;
    if (!messages || messages.length <= liveEntryIds.length) return;
    const newMessages = messages.slice(liveEntryIds.length).map(enrich);
    const newIds = await getStore().current().appendMessages(newMessages);
    liveEntryIds = [...liveEntryIds, ...newIds];
  };

  ctx.bus.on("agent:processing-done", () => { void flush(); });

  return {
    flush,
    getEntryIdAt: (i) => liveEntryIds[i] ?? null,
    resetTo: (ids) => { liveEntryIds = [...ids]; },
  };
}
