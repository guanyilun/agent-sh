import * as path from "node:path";
import type { ExtensionContext } from "../../../shell/host-types.js";
import type { AgentShMessage } from "../../llm-client.js";
import { SharedFileStore } from "../../store.js";
import {
  activate as activateSummaryStrategy,
  readSummaryLines,
  type SummaryCtx,
} from "./strategy.js";
import { recallSearch, recallExpand, recallBrowse } from "./recall.js";

export default function activate(ctx: ExtensionContext): void {
  const { maxBytes, prefetchEntries } = ctx.getExtensionSettings("rolling-history", {
    maxBytes: undefined as number | undefined,
    prefetchEntries: 50,
  });
  const storeDir = ctx.getStoragePath("rolling-history");
  const summaryStore = new SharedFileStore({
    filePath: path.join(storeDir, "history.jsonl"),
    maxBytes,
  });

  const summaryCtx: SummaryCtx = {
    store: summaryStore,
    bus: { on: (e, f) => ctx.bus.on(e, f) },
    advise: (op, f) => { ctx.advise(op, f as Parameters<typeof ctx.advise>[1]); },
    iid: ctx.instanceId,
    getMessages: () => (ctx.call("conversation:get-messages") as AgentShMessage[] | undefined) ?? [],
    replaceMessages: (msgs) => { ctx.call("conversation:replace-messages", msgs); },
    estimateTokens: () => (ctx.call("conversation:estimate-tokens") as number | undefined) ?? 0,
    estimatePromptTokens: () => (ctx.call("conversation:estimate-prompt-tokens") as number | undefined) ?? 0,
    linkMessage: (index, entryId) => { ctx.call("conversation:link", index, entryId); },
  };
  activateSummaryStrategy(summaryCtx);

  ctx.define("recall:search", async (query: string) => recallSearch(summaryStore, query));
  ctx.define("recall:expand", async (id: string) => recallExpand(summaryStore, id));
  ctx.define("recall:browse", async (limit?: number) => recallBrowse(summaryStore, limit));

  if (prefetchEntries > 0) {
    Promise.resolve().then(async () => {
      const lines = await readSummaryLines(summaryStore, prefetchEntries);
      if (lines.length === 0) return;
      const current = (ctx.call("conversation:get-messages") as AgentShMessage[] | undefined) ?? [];
      ctx.call("conversation:replace-messages", [
        ...current,
        {
          role: "user",
          content: `[Prior session history — loaded from the summary store]\n${lines.join("\n")}`,
        },
      ]);
    }).catch(() => {});
  }
}
