import type { ExtensionContext } from "agent-sh/types";
import type { MultiSessionStore } from "./multi-session-store.js";
import type { AgentMessage } from "./session-store.js";

export interface Capture {
  /** Persist any messages added since the last capture (called on turn-end). */
  flush(): Promise<void>;
  /** Entry id for the message at this index of the live array, or null
   *  if that slot is a synthetic (e.g. compaction summary) that lives only
   *  in-memory. */
  getEntryIdAt(messageIndex: number): string | null;
  /** Length of the parallel id array — should match live messages length. */
  size(): number;
  /** Rewrite the parallel array after an external messages replacement
   *  (compaction, /resume, /new). Pass the entry id for each live message,
   *  or null for synthetic slots. */
  resetTo(ids: (string | null)[]): void;
}

/** Persist raw messages into the session store at turn-end. Maintains a
 *  parallel `(entryId | null)[]` that matches the live messages array so
 *  compaction can map message indices back to on-disk entry ids. */
export function registerCapture(
  ctx: ExtensionContext,
  store: () => MultiSessionStore,
): Capture {
  let liveEntryIds: (string | null)[] = [];

  const flush = async (): Promise<void> => {
    const messages = ctx.call("conversation:get-messages") as AgentMessage[] | undefined;
    if (!messages || messages.length <= liveEntryIds.length) return;
    const newMessages = messages.slice(liveEntryIds.length);
    const newIds = await store().current().appendMessages(newMessages);
    liveEntryIds = [...liveEntryIds, ...newIds];
  };

  ctx.bus.on("agent:processing-done", () => { void flush(); });

  return {
    flush,
    getEntryIdAt: (i) => liveEntryIds[i] ?? null,
    size: () => liveEntryIds.length,
    resetTo: (ids) => { liveEntryIds = [...ids]; },
  };
}
