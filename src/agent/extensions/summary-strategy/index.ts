import * as path from "node:path";
import type { AgentContext } from "../../host-types.js";
import type { LiveView } from "../../live-view.js";
import { SharedFileStore } from "../../store.js";
import {
  activate as activateSummaryStrategy,
  readSummaryLines,
  type SummaryCtx,
} from "./strategy.js";
import { recallSearch, recallExpand, recallBrowse } from "./recall.js";
import { SUMMARY_STORE } from "./constants.js";

export default function activate(ctx: AgentContext): void {
  const agentSurface = ctx.agent;

  const { maxBytes, prefetchEntries } = ctx.getExtensionSettings("summary-strategy", {
    maxBytes: undefined as number | undefined,
    prefetchEntries: 50,
  });
  const storeDir = ctx.getStoragePath("summary-strategy");
  const summaryStore = new SharedFileStore({
    filePath: path.join(storeDir, "history.jsonl"),
    maxBytes,
  });
  agentSurface.registerStore(SUMMARY_STORE, summaryStore);

  const summaryCtx: SummaryCtx = {
    // Strategy callbacks only fire while ash is active, so liveView is
    // non-null at call time. Throwing is preferred over silent skip — a
    // surprise null here is a wiring bug, not a runtime condition.
    get liveView(): LiveView {
      const v = agentSurface.liveView;
      if (!v) throw new Error("summary-strategy: liveView unavailable (ash backend not active)");
      return v;
    },
    store: (name) => agentSurface.store(name),
    bus: { on: (e, f) => ctx.bus.on(e, f) },
    advise: (op, f) => { ctx.advise(op, f as Parameters<typeof ctx.advise>[1]); },
    iid: ctx.instanceId,
  };
  activateSummaryStrategy(summaryCtx);

  ctx.define("recall:search", async (query: string) => recallSearch(summaryStore, query));
  ctx.define("recall:expand", async (id: string) => recallExpand(summaryStore, id));
  ctx.define("recall:browse", async (limit?: number) => recallBrowse(summaryStore, limit));

  if (prefetchEntries > 0) {
    Promise.resolve().then(async () => {
      const lines = await readSummaryLines(summaryStore, prefetchEntries);
      if (lines.length === 0) return;
      const liveView = agentSurface.liveView;
      if (!liveView) return; // ash not active yet; skip prefetch
      liveView.replace([
        ...liveView.get(),
        {
          role: "user",
          content: `[Prior session history — loaded from the summary store]\n${lines.join("\n")}`,
        },
      ]);
    }).catch(() => {});
  }
}
