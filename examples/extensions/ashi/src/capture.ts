import type { ShellContext } from "agent-sh/types";
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
  ctx: ShellContext,
  getStore: () => MultiSessionStore,
): Capture {
  let liveEntryIds: (string | null)[] = [];

  const flush = async (): Promise<void> => {
    const messages = ctx.call("conversation:get-messages") as AgentMessage[] | undefined;
    if (!messages || messages.length <= liveEntryIds.length) return;
    const newMessages = messages.slice(liveEntryIds.length);
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
