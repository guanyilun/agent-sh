import * as path from "node:path";
import type { ExtensionContext } from "../../../shell/host-types.js";
import type { AgentShMessage } from "../../llm-client.js";
import { contentText, type ToolDefinition } from "../../types.js";
import { SharedFileStore } from "../../store.js";
import {
  activate as activateSummaryStrategy,
  readSummaryLines,
  type SummaryCtx,
} from "./strategy.js";
import { recallSearch, recallExpand, recallBrowse } from "./recall.js";

const TOOL_NAME = "conversation_recall";
const INSTRUCTION_NAME = "recall-guidance";
const INSTRUCTION_TEXT =
  "When starting a task that may have been discussed before (conventions, preferences, corrections, prior examples), " +
  "use conversation_recall to search history for relevant prior entries. " +
  "Treat recurring user guidance as standing preferences. " +
  "If a search returns nothing useful, try: shorter queries, alternate terms, or browse to scan the full timeline. " +
  "Recall only covers this and recent sessions — for older context, also search the filesystem (grep, glob).";

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

  // `/history off` gates only store.append; the tool + instruction stay
  // registered so toggling never perturbs the tools array or system prompt
  // (i.e. never invalidates the LLM cache).
  let enabled = true;
  const gatedStore: typeof summaryStore = Object.create(summaryStore);
  gatedStore.append = (entries, opts) => enabled ? summaryStore.append(entries, opts) : Promise.resolve();

  const summaryCtx: SummaryCtx = {
    store: gatedStore,
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

  const toolDef: ToolDefinition = {
    name: TOOL_NAME,
    displayName: "recall",
    description:
      "Browse, search, or expand evicted conversation turns. " +
      "Use when you need context from earlier in the conversation that was compacted away. " +
      "Search is regex-based and covers both summaries and full body text. " +
      "If search doesn't find what you expect, try broader/shorter terms or browse to scan the timeline.",
    input_schema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["browse", "search", "expand"],
          description: "browse: list evicted turns, search: regex search, expand: show full turn",
        },
        query: { type: "string", description: "Search query (for action=search)" },
        turn_id: { type: "number", description: "Turn ID to expand (for action=expand)" },
      },
      required: ["action"],
    },
    execute: async (args) => {
      const action = args.action as string;
      let content: string;
      if (action === "search") {
        content = await recallSearch(summaryStore, (args.query as string) ?? "");
      } else if (action === "expand") {
        content = await recallExpand(summaryStore, args.turn_id as string);
      } else {
        content = await recallBrowse(summaryStore);
      }
      return { content, exitCode: 0, isError: false };
    },
    formatResult: (args, result) => {
      const action = args.action as string;
      const text = contentText(result.content);
      if (result.isError) return { summary: "error" };
      if (action === "search") {
        if (text.startsWith("No results")) return { summary: "0 matches" };
        const m = text.match(/^Found (\d+)/);
        return { summary: m ? `${m[1]} matches` : "search done" };
      }
      if (action === "browse") {
        if (text.startsWith("No conversation")) return { summary: "empty" };
        return { summary: "browsed" };
      }
      if (text.includes("no expanded content")) return { summary: "not found" };
      return { summary: "expanded" };
    },
    getDisplayInfo: () => ({ kind: "search", icon: "⟲" }),
  };

  if (ctx.agent) {
    ctx.agent.registerTool(toolDef);
    ctx.agent.registerInstruction(INSTRUCTION_NAME, INSTRUCTION_TEXT);
  }

  ctx.registerCommand("history", "Toggle conversation history writes (on / off / status).", (args) => {
    const arg = args.trim().toLowerCase();
    if (arg === "" || arg === "status") {
      ctx.bus.emit("ui:info", { message: `history: writes ${enabled ? "on" : "off"} — recall remains available for prior sessions` });
      return;
    }
    if (arg === "on") {
      if (enabled) { ctx.bus.emit("ui:info", { message: "history: already on" }); return; }
      enabled = true;
      ctx.bus.emit("ui:info", { message: "history: on — new turns will be summarized" });
      return;
    }
    if (arg === "off") {
      if (!enabled) { ctx.bus.emit("ui:info", { message: "history: already off" }); return; }
      enabled = false;
      ctx.bus.emit("ui:info", { message: "history: off — new turns won't be summarized (recall still available)" });
      return;
    }
    ctx.bus.emit("ui:info", { message: `history: unknown arg "${arg}" (use on / off / status)` });
  });

  if (prefetchEntries > 0) {
    Promise.resolve().then(async () => {
      if (!enabled) return;
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
