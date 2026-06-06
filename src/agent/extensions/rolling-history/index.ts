import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "../../../shell/host-types.js";
import type { AgentShMessage } from "../../llm-client.js";
import { contentText, type ToolDefinition } from "../../types.js";
import { SharedFileStore, newEntryId, type Store, type Entry } from "../../store.js";
import { CONFIG_DIR, getSettings } from "../../../core/settings.js";
import { deserializeEntry, isReadOnly } from "../../nuclear-form.js";
import {
  activate as activateSummaryStrategy,
  nuclearToEntry,
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

/** One-time migration: old ~/.agent-sh/history → rolling-history store. */
export function migrateFromLegacy(
  storeDir: string,
  legacyPath: string,
  ctx: Pick<ExtensionContext, "bus">,
): void {
  const sentinel = path.join(storeDir, ".migrated");
  if (fs.existsSync(sentinel)) return;

  const newFile = path.join(storeDir, "history.jsonl");
  if (fs.existsSync(newFile) && fs.statSync(newFile).size > 0) {
    try { fs.writeFileSync(sentinel, ""); } catch { /* ignore */ }
    return;
  }

  if (!fs.existsSync(legacyPath)) {
    try { fs.writeFileSync(sentinel, ""); } catch { /* ignore */ }
    return;
  }

  let migrated = 0;
  try {
    const lines = fs.readFileSync(legacyPath, "utf-8").split("\n").filter(Boolean);
    const entries: Entry[] = [];
    for (const line of lines) {
      const ne = deserializeEntry(line);
      if (!ne) continue;
      if (isReadOnly(ne)) continue;
      entries.push(nuclearToEntry(ne, newEntryId()));
    }
    if (entries.length > 0) {
      fs.writeFileSync(newFile, entries.map((e) => JSON.stringify(e) + "\n").join(""));
      migrated = entries.length;
    }
  } catch {
    return; // retry next start
  }

  try { fs.writeFileSync(sentinel, ""); } catch { /* ignore */ }
  if (migrated > 0) {
    ctx.bus.emit("ui:info", { message: `history: migrated ${migrated} entries from legacy ~/.agent-sh/history` });
  }
}

export default function activate(ctx: ExtensionContext): void {
  const { maxBytes, prefetchEntries } = ctx.getExtensionSettings("rolling-history", {
    maxBytes: undefined as number | undefined,
    prefetchEntries: 50,
  });
  const storeDir = ctx.getStoragePath("rolling-history");
  const settings = getSettings();
  const legacyPath = settings.historyFilePath ?? path.join(CONFIG_DIR, "history");
  migrateFromLegacy(storeDir, legacyPath, ctx);
  const summaryStore = new SharedFileStore({
    filePath: path.join(storeDir, "history.jsonl"),
    maxBytes,
  });

  // `/history off` gates only writes — store.append and the linkMessage
  // back-stamp. Everything else (meta.tool stamping, compact's reorg,
  // recall reads) runs identically on both sides. Tool + instruction stay
  // registered either way so toggling never perturbs the tools array or
  // system prompt (LLM prompt cache is preserved).
  let enabled = true;
  const gatedStore: Store = {
    append: (entries, opts) => enabled ? summaryStore.append(entries, opts) : Promise.resolve(),
    findById: (id) => summaryStore.findById(id),
    readRecent: (n) => summaryStore.readRecent(n),
    search: (q) => summaryStore.search(q),
  };

  const summaryCtx: SummaryCtx = {
    store: gatedStore,
    bus: { on: (e, f) => ctx.bus.on(e, f) },
    advise: (op, f) => { ctx.advise(op, f as Parameters<typeof ctx.advise>[1]); },
    iid: ctx.instanceId,
    getMessages: () => (ctx.call("conversation:get-messages") as AgentShMessage[] | undefined) ?? [],
    replaceMessages: (msgs) => { ctx.call("conversation:replace-messages", msgs); },
    estimateTokens: () => (ctx.call("conversation:estimate-tokens") as number | undefined) ?? 0,
    estimatePromptTokens: () => (ctx.call("conversation:estimate-prompt-tokens") as number | undefined) ?? 0,
    linkMessage: (index, entryId) => { if (enabled) ctx.call("conversation:link", index, entryId); },
  };
  activateSummaryStrategy(summaryCtx);

  const toolDef: ToolDefinition = {
    name: TOOL_NAME,
    displayName: "recall",
    description:
      "Browse, search, or expand the persistent conversation memory — all captured turns across this and recent sessions. " +
      "Use when you need context from prior turns or past sessions that may no longer be in the active window. " +
      "Search accepts a regex pattern (e.g. 'foo|bar') and falls back to literal matching if the pattern is invalid. " +
      "Covers both summaries and full body text. " +
      "If search doesn't find what you expect, try broader/shorter terms or browse to scan the timeline. " +
      "Use offset for pagination on both browse and search.",
    input_schema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["browse", "search", "expand"],
          description: "browse: list recent captured turns, search: regex search across memory, expand: show full turn body",
        },
        query: { type: "string", description: "Search pattern — a regex (e.g. 'foo|bar') or literal text (for action=search)" },
        turn_id: { type: "string", description: "Turn ID to expand (for action=expand)" },
        offset: {
          type: "number",
          description: "Skip first N results; for browse, start at this entry offset; for search, skip first N hits. Default 0.",
        },
        limit: {
          type: "number",
          description: "Max entries to return for browse (default 25) or search (default 30).",
        },
      },
      required: ["action"],
    },
    execute: async (args) => {
      const action = args.action as string;
      const offset = (args.offset as number) ?? 0;
      const limit = (args.limit as number) ?? (action === "search" ? 30 : 25);
      let content: string;
      if (action === "search") {
        content = await recallSearch(summaryStore, (args.query as string) ?? "", offset, limit);
      } else if (action === "expand") {
        content = await recallExpand(summaryStore, args.turn_id as string);
      } else {
        content = await recallBrowse(summaryStore, offset, limit);
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
