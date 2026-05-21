import {
  TUI,
  ProcessTerminal,
  Container,
  Editor,
  Image,
  Loader,
  SelectList,
  Spacer,
  type Component,
  type SelectItem,
  getImageDimensions,
  matchesKey,
  isKeyRelease,
  isKeyRepeat,
} from "@earendil-works/pi-tui";
import type { ExtensionContext } from "agent-sh/types";
import { editorTheme, selectListTheme, theme } from "./theme.js";
import {
  AssistantMessage,
  ErrorLine,
  InfoLine,
  ThinkingBlock,
  ToolGroup,
} from "./components.js";
import type { ToolCallView, ToolResultView } from "./hooks.js";
import { createToolHookResolver } from "./hooks.js";

const GROUPABLE_KINDS = new Set(["read", "search"]);
const TOOL_KIND: Record<string, string> = {
  read_file: "read", ls: "read",
  grep: "search", glob: "search",
};
import { BusAutocompleteProvider } from "./autocomplete.js";
import { StatusFooter } from "./status-footer.js";
import type { MultiSessionStore } from "./multi-session-store.js";
import type { SessionEntry } from "./session-store.js";
import { formatSessionRow } from "./session-commands.js";
import { resumeSession } from "./session-commands.js";
import { applyBranchMessages } from "./commands.js";
import type { Capture } from "./capture.js";
import { execSync } from "node:child_process";
import { renderDiff, detectLanguage, highlightLine } from "agent-sh/utils/diff-renderer.js";
import { renderBoxFrame } from "agent-sh/utils/box-frame.js";

interface DiffStats { added: number; removed: number; isNewFile: boolean; isIdentical: boolean }

function buildDiffRenderer(
  diff: DiffStats & Parameters<typeof renderDiff>[0],
  filePath: string,
): (width: number) => string[] {
  return (width) => {
    const boxW = Math.max(40, width);
    const contentW = Math.max(20, boxW - 4);
    const inner = diff.isNewFile
      ? renderNewFilePreview(diff, 30, filePath)
      : ((): string[] => {
          const lines = renderDiff(diff, {
            width: contentW, filePath, trueColor: true, maxLines: Number.MAX_SAFE_INTEGER, mode: "unified",
          });
          return lines.length > 1 ? ["", ...lines.slice(1), ""] : lines;
        })();
    return renderBoxFrame(inner, {
      width: boxW,
      style: "rounded",
      title: diffFrameTitle(filePath, diff),
    });
  };
}

function renderNewFilePreview(
  diff: { hunks?: { lines: { type: string; text: string }[] }[] },
  maxLines: number,
  filePath: string,
): string[] {
  const lines = diff.hunks?.[0]?.lines.filter((l) => l.type === "added") ?? [];
  const shown = lines.slice(0, maxLines);
  const overflow = lines.length - shown.length;
  const noW = String(shown.length).length || 1;
  const lang = detectLanguage(filePath);
  const body = shown.map((l, i) => {
    const no = String(i + 1).padStart(noW);
    return `${theme.fg("muted", `${no} │`)} ${highlightLine(l.text, lang)}`;
  });
  if (overflow > 0) body.push(theme.fg("muted", `… ${overflow} more lines`));
  return ["", ...body, ""];
}

function diffFrameTitle(filePath: string, diff: DiffStats): string {
  const stats = diff.isNewFile
    ? theme.fg("success", `+${diff.added}`)
    : `${theme.fg("success", `+${diff.added}`)} ${theme.fg("error", `-${diff.removed}`)}`;
  return `${theme.fg("muted", filePath)}  ${stats}`;
}

function readReasoning(m: unknown): string {
  const mm = m as { reasoning?: unknown; reasoning_content?: unknown };
  const r = mm.reasoning ?? mm.reasoning_content;
  return typeof r === "string" ? r : "";
}

function currentGitBranch(cwd: string): string | undefined {
  try {
    const out = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd, stdio: ["ignore", "pipe", "ignore"], timeout: 500,
    }).toString().trim();
    return out || undefined;
  } catch { return undefined; }
}

const fgAccent = (t: string): string => theme.fg("accent", t);
const fgMuted = (t: string): string => theme.fg("muted", t);

function detailFromArgs(argsJson: string | undefined): string {
  if (!argsJson) return "";
  try {
    const args = JSON.parse(argsJson) as Record<string, unknown>;
    if (typeof args.command === "string") return `$ ${args.command}`;
    if (typeof args.pattern === "string") return args.pattern;
    if (typeof args.path === "string") return relativize(args.path);
    if (typeof args.file_path === "string") return relativize(args.file_path);
    if (typeof args.query === "string") return `"${args.query}"`;
  } catch { /* fall through */ }
  return "";
}

/** Recompute the per-tool summary from a saved tool result message. We don't
 *  persist resultDisplay, so /resume would otherwise lose "16 entries" / "117
 *  lines" etc. Mirrors agent-sh's formatResult logic for the common tools. */
function inferSummary(toolName: string, content: unknown): string | undefined {
  if (typeof content !== "string" || content.length === 0) return undefined;
  const lines = content.split("\n").filter((l) => l.length > 0);
  switch (toolName) {
    case "ls":
      if (content === "(empty directory)") return "0 entries";
      return `${lines.length} entries`;
    case "glob":
      if (content === "No files matched.") return "0 files";
      return `${lines.length} files`;
    case "grep":
      if (content === "No matches found.") return "0 matches";
      return `${lines.length} lines`;
    case "read_file":
      if (content.startsWith("File unchanged")) return "cached";
      return `${lines.length} lines`;
    default:
      return undefined;
  }
}

function relativize(fp: string): string {
  const home = process.env.HOME;
  const cwd = process.cwd();
  if (fp.startsWith(`${cwd}/`)) return fp.slice(cwd.length + 1);
  if (home && fp.startsWith(`${home}/`)) return `~/${fp.slice(home.length + 1)}`;
  return fp;
}

export interface AshiHandle {
  tui: TUI;
  stop: () => void;
  openTreePicker: () => Promise<void>;
  openSessionPicker: () => Promise<void>;
  rebuildChat: () => Promise<void>;
}

export function mountAshi(
  ctx: ExtensionContext,
  getStore: () => MultiSessionStore,
  capture: Capture,
): AshiHandle {
  const { bus } = ctx;
  const terminal = new ProcessTerminal();
  const tui = new TUI(terminal);

  const chat = new Container();
  const footerSlot = new Container();
  const queueSlot = new Container();
  const editor = new Editor(tui, editorTheme(), { paddingX: 1 });
  editor.setAutocompleteProvider(new BusAutocompleteProvider(bus));
  editor.onSubmit = (text) => {
    const query = text.trim();
    if (!query) return;
    editor.setText("");
    if (query.startsWith("/")) {
      const sp = query.indexOf(" ");
      const name = sp === -1 ? query : query.slice(0, sp);
      const args = sp === -1 ? "" : query.slice(sp + 1).trim();
      bus.emit("command:execute", { name, args });
      return;
    }
    if (processing) {
      queuedQueries.push(query);
      renderQueueSlot();
      tui.requestRender();
      return;
    }
    bus.emit("agent:submit", { query });
  };

  const statusFooter = new StatusFooter();
  const cwd = ctx.call("cwd") as string;
  statusFooter.update({ cwd, branch: currentGitBranch(cwd) });
  let compactions = 0;
  const refreshFooterStats = (): void => {
    const tokens = ctx.call("conversation:estimate-prompt-tokens") as number | undefined;
    statusFooter.update({ tokens: tokens ?? 0 });
  };
  const refreshBranch = (): void => {
    statusFooter.update({ branch: currentGitBranch(cwd) });
  };
  const refreshThinking = (): void => {
    const { level, supported } = bus.emitPipe("config:get-thinking", {
      level: "off", levels: [] as string[], supported: true,
    });
    statusFooter.update({ thinking: supported ? level : undefined });
  };

  tui.addChild(chat);
  tui.addChild(footerSlot);
  tui.addChild(queueSlot);
  tui.addChild(editor);
  tui.addChild(statusFooter);
  tui.setFocus(editor);

  interface ToolPair { call: ToolCallView; result: ToolResultView; startedAt: number }
  type LiveToolEntry = { kind: "pair"; pair: ToolPair } | { kind: "group"; group: ToolGroup };

  let activeAssistant: AssistantMessage | null = null;
  let activeThinking: ThinkingBlock | null = null;
  const activeTools = new Map<string, LiveToolEntry>();
  /** Per-batch state from agent:tool-batch — the group is created lazily on
   *  the first member's tool-started so the chat insertion order is correct. */
  const batchGroups = new Map<string, { total: number; group: ToolGroup | null }>();
  let lastToolResult: ToolResultView | null = null;
  let loader: Loader | null = null;
  let processing = false;
  const queuedQueries: string[] = [];

  const renderQueueSlot = (): void => {
    queueSlot.clear();
    for (const q of queuedQueries) {
      const oneLine = q.replace(/\s+/g, " ");
      const preview = oneLine.length > 80 ? oneLine.slice(0, 77) + "…" : oneLine;
      queueSlot.addChild(new InfoLine(`↳ queued: ${preview}`));
    }
  };
  let hideThinking = true;

  const renderState = (): { state: Record<string, unknown>; invalidate: () => void } => ({
    state: {},
    invalidate: () => tui.requestRender(),
  });

  const tools = createToolHookResolver(ctx, renderState);

  const renderUserMessage = (text: string): Component =>
    ctx.call("ashi:render-user-message", { text, ...renderState() }) as Component;

  const renderAssistantLive = (): AssistantMessage =>
    ctx.call("ashi:render-assistant", { text: "", ...renderState() }) as AssistantMessage;

  const renderAssistantFinal = (text: string): Component =>
    ctx.call("ashi:render-assistant", { text, ...renderState() }) as Component;

  const renderThinkingLive = (): ThinkingBlock =>
    ctx.call("ashi:render-thinking", { text: "", hidden: hideThinking, ...renderState() }) as ThinkingBlock;

  const renderThinkingFinal = (text: string): Component =>
    ctx.call("ashi:render-thinking", { text, hidden: hideThinking, ...renderState() }) as Component;

  const renderToolPair = (args: {
    toolCallId: string; name: string; title: string;
    kind?: string; displayDetail?: string; rawInput?: unknown;
  }): ToolPair => {
    const call = tools.call(args);
    const result = tools.result({
      toolCallId: args.toolCallId,
      name: args.name,
      kind: args.kind,
      rawInput: args.rawInput,
    });
    return { call, result, startedAt: Date.now() };
  };

  const ensureAssistant = (): AssistantMessage => {
    if (!activeAssistant) {
      activeAssistant = renderAssistantLive();
      chat.addChild(activeAssistant);
    }
    return activeAssistant;
  };

  const finalizeThinking = (): void => {
    if (activeThinking) {
      activeThinking.finalize();
      activeThinking = null;
    }
  };

  const ensureThinking = (): ThinkingBlock => {
    if (!activeThinking) {
      activeThinking = renderThinkingLive();
      chat.addChild(activeThinking);
    }
    return activeThinking;
  };

  const startLoader = (): void => {
    if (loader) return;
    loader = new Loader(tui, fgAccent, fgMuted, "thinking…");
    footerSlot.addChild(loader);
  };
  const stopLoader = (): void => {
    if (!loader) return;
    loader.stop();
    footerSlot.removeChild(loader);
    loader = null;
  };

  type ReplayEntry =
    | { kind: "pair"; pair: ToolPair; name: string }
    | { kind: "group"; group: ToolGroup; name: string };

  const replayEntry = (entry: SessionEntry, toolMap: Map<string, ReplayEntry>): void => {
    if (entry.type === "session") return;
    if (entry.type === "compaction") {
      chat.addChild(new InfoLine(`▼ compacted (firstKept=${entry.firstKeptId.slice(0, 6)}, ${entry.tokensBefore} tokens)`));
      return;
    }
    const m = entry.message;
    if (m.role === "user") {
      const text = typeof m.content === "string" ? m.content : "";
      if (text.startsWith("[Compacted conversation summary]")) return;
      chat.addChild(renderUserMessage(text));
    } else if (m.role === "assistant") {
      const reasoning = readReasoning(m);
      if (reasoning) {
        chat.addChild(renderThinkingFinal(reasoning));
      }
      const text = typeof m.content === "string" ? m.content : "";
      if (text) {
        chat.addChild(renderAssistantFinal(text));
      }
      if (m.tool_calls) {
        const calls = m.tool_calls;
        let i = 0;
        while (i < calls.length) {
          const startName = calls[i]!.function?.name ?? "";
          const startKind = TOOL_KIND[startName];
          if (startKind && GROUPABLE_KINDS.has(startKind)) {
            let j = i;
            while (j < calls.length && TOOL_KIND[calls[j]!.function?.name ?? ""] === startKind) j++;
            const runLen = j - i;
            if (runLen > 1) {
              const group = new ToolGroup(startKind, runLen);
              chat.addChild(group);
              for (let k = i; k < j; k++) {
                const c = calls[k]!;
                const cid = c.id ?? "";
                const cname = c.function?.name ?? "tool";
                group.addCall(cid, cname, detailFromArgs(c.function?.arguments));
                if (cid) toolMap.set(cid, { kind: "group", group, name: cname });
              }
              i = j;
              continue;
            }
          }
          const tc = calls[i]!;
          const id = tc.id ?? "";
          const name = tc.function?.name ?? "tool";
          const pair = renderToolPair({
            toolCallId: id, name, title: name, kind: undefined,
            displayDetail: detailFromArgs(tc.function?.arguments),
            rawInput: tc.function?.arguments,
          });
          chat.addChild(pair.call);
          chat.addChild(pair.result);
          if (id) toolMap.set(id, { kind: "pair", pair, name });
          lastToolResult = pair.result;
          i++;
        }
      }
    } else if (m.role === "tool") {
      const id = m.tool_call_id ?? "";
      const text = typeof m.content === "string" ? m.content : "";
      const found = id ? toolMap.get(id) : undefined;
      if (!found) {
        chat.addChild(new InfoLine(`tool result (no matching call): ${text.slice(0, 80)}`));
        return;
      }
      const summary = inferSummary(found.name, text);
      if (found.kind === "group") {
        found.group.recordCompletion(id, 0, summary);
      } else {
        const meta = m.meta as { diff?: unknown; filePath?: string } | undefined;
        if (meta?.diff && typeof meta.filePath === "string") {
          const diff = meta.diff as DiffStats & Parameters<typeof renderDiff>[0];
          if (!diff.isIdentical) {
            found.pair.result.setDiffRenderer(buildDiffRenderer(diff, meta.filePath));
          }
        }
        found.pair.result.finalize({ exitCode: 0, summary });
        found.pair.call.setStatus({ exitCode: 0, elapsedMs: 0, summary });
      }
      if (id) toolMap.delete(id);
    }
  };

  const rebuildChat = async (): Promise<void> => {
    activeAssistant = null;
    activeThinking = null;
    activeTools.clear();
    batchGroups.clear();
    lastToolResult = null;
    chat.clear();
    const branch = await getStore().current().getBranch();
    const toolMap = new Map<string, ReplayEntry>();
    for (const e of branch) replayEntry(e, toolMap);
    // Match the trailing gap that processing-done adds in live turns, so the
    // editor doesn't sit flush against the last replayed response.
    chat.addChild(new Spacer(1));
    tui.requestRender();
  };

  // ── Bus wiring ───────────────────────────────────────────────
  bus.on("agent:query", ({ query }) => {
    chat.addChild(renderUserMessage(query));
    activeAssistant = null;
    tui.requestRender();
  });

  bus.on("agent:processing-start", () => {
    processing = true;
    startLoader();
    tui.requestRender();
  });

  const imageComponentFromPng = (data: Buffer): Image | null => {
    const base64 = data.toString("base64");
    const dims = getImageDimensions(base64, "image/png");
    if (!dims) return null;
    return new Image(
      base64, "image/png",
      { fallbackColor: (t) => theme.fg("muted", t) },
      { maxWidthCells: 60, maxHeightCells: 20 },
      dims,
    );
  };

  /** Drop the live assistant message so the image lands as its own block,
   *  then subsequent text starts a fresh markdown context below it. */
  const appendImage = (data: Buffer): void => {
    const img = imageComponentFromPng(data);
    if (!img) return;
    if (activeAssistant) { activeAssistant.finalize(); activeAssistant = null; }
    chat.addChild(img);
  };

  // tui-renderer normally owns render:image, but ashi disables it; provide
  // our own so latex-images and friends reach the chat.
  ctx.define("render:image", (data: Buffer) => {
    appendImage(data);
    tui.requestRender();
  });

  bus.on("agent:response-chunk", ({ blocks }) => {
    finalizeThinking();
    for (const b of blocks) {
      if (b.type === "text") ensureAssistant().appendText(b.text);
      else if (b.type === "code-block") ensureAssistant().appendCodeBlock(b.language, b.code);
      else if (b.type === "image") appendImage(b.data);
    }
    tui.requestRender();
  });

  bus.on("agent:thinking-chunk", ({ text }) => {
    if (activeAssistant) { activeAssistant.finalize(); activeAssistant = null; }
    ensureThinking().appendText(text);
    tui.requestRender();
  });

  bus.on("agent:tool-batch", (e) => {
    batchGroups.clear();
    for (const g of e.groups) {
      batchGroups.set(g.kind, { total: g.tools.length, group: null });
    }
  });

  bus.on("agent:tool-started", (e) => {
    finalizeThinking();
    if (activeAssistant) {
      activeAssistant.finalize();
      activeAssistant = null;
    }
    const id = e.toolCallId ?? `${e.title}-${Date.now()}`;
    const title = e.title.split(":")[0]!.trim();
    const detail = e.displayDetail || detailFromArgs(
      typeof e.rawInput === "string" ? e.rawInput : JSON.stringify(e.rawInput ?? {})
    );

    const kind = e.kind ?? "";
    const batchEntry = batchGroups.get(kind);
    const shouldGroup = !!batchEntry && batchEntry.total > 1 && GROUPABLE_KINDS.has(kind);
    if (shouldGroup) {
      if (!batchEntry!.group) {
        batchEntry!.group = new ToolGroup(kind, batchEntry!.total);
        chat.addChild(batchEntry!.group);
      }
      batchEntry!.group.addCall(id, title, detail);
      activeTools.set(id, { kind: "group", group: batchEntry!.group });
      // Grouped tools have no individual result body — Ctrl+O wouldn't have
      // anything to expand, so leave lastToolResult pointing at the prior tool.
      tui.requestRender();
      return;
    }

    const pair = renderToolPair({
      toolCallId: id, name: title, title, kind: e.kind,
      displayDetail: detail, rawInput: e.rawInput,
    });
    activeTools.set(id, { kind: "pair", pair });
    chat.addChild(pair.call);
    chat.addChild(pair.result);
    lastToolResult = pair.result;
    tui.requestRender();
  });

  bus.on("agent:tool-output-chunk", ({ chunk }) => {
    for (const entry of [...activeTools.values()].reverse()) {
      if (entry.kind === "pair") {
        entry.pair.result.appendChunk(chunk);
        tui.requestRender();
        return;
      }
    }
  });

  bus.on("agent:tool-completed", (e) => {
    const id = e.toolCallId;
    if (!id) return;
    const entry = activeTools.get(id);
    if (!entry) return;
    const summary = e.resultDisplay?.summary;
    if (entry.kind === "group") {
      entry.group.recordCompletion(id, e.exitCode, summary);
      activeTools.delete(id);
      tui.requestRender();
      return;
    }
    const pair = entry.pair;
    const body = e.resultDisplay?.body;
    if (body?.kind === "diff") {
      const diff = body.diff as DiffStats & Parameters<typeof renderDiff>[0];
      if (!diff.isIdentical) {
        pair.result.setDiffRenderer(buildDiffRenderer(diff, body.filePath));
      }
    }
    pair.call.setStatus({ exitCode: e.exitCode, elapsedMs: Date.now() - pair.startedAt, summary });
    pair.result.finalize({ exitCode: e.exitCode, summary });
    activeTools.delete(id);
    tui.requestRender();
  });

  bus.on("agent:processing-done", () => {
    processing = false;
    stopLoader();
    finalizeThinking();
    if (activeAssistant) activeAssistant.finalize();
    chat.addChild(new Spacer(1));
    refreshFooterStats();
    refreshBranch();
    const next = queuedQueries.shift();
    if (next !== undefined) {
      renderQueueSlot();
      bus.emit("agent:submit", { query: next });
    }
    tui.requestRender();
  });

  bus.on("agent:usage", (u) => {
    if (u.prompt_tokens > 0) {
      statusFooter.update({ tokens: u.prompt_tokens });
      tui.requestRender();
    }
  });

  bus.on("agent:cancelled", () => {
    processing = false;
    stopLoader();
    chat.addChild(new InfoLine("cancelled"));
    tui.requestRender();
  });

  bus.on("agent:error", ({ message }) => {
    processing = false;
    stopLoader();
    chat.addChild(new ErrorLine(message));
    tui.requestRender();
  });

  bus.on("ui:info", ({ message }) => {
    chat.addChild(new InfoLine(message));
    tui.requestRender();
  });

  bus.on("ui:error", ({ message }) => {
    chat.addChild(new ErrorLine(message));
    tui.requestRender();
  });

  bus.on("agent:info", (info) => {
    statusFooter.update({
      model: info.model,
      provider: info.provider,
      contextWindow: info.contextWindow,
    });
    refreshThinking();
    tui.requestRender();
  });

  bus.on("config:changed", () => {
    refreshThinking();
    tui.requestRender();
  });

  bus.on("conversation:after-compact", () => {
    compactions++;
    statusFooter.update({ compactions });
    refreshFooterStats();
    tui.requestRender();
  });

  refreshFooterStats();

  // ── Pickers ────────────────────────────────────────────────────
  let pickerOpen = false;
  let activeSessionPicker: SelectList | null = null;
  let activeSessionRepopulate: ((keepIndex?: number) => Promise<boolean>) | null = null;
  let activeSessionClose: (() => void) | null = null;

  const openTreePicker = async (): Promise<void> => {
    if (pickerOpen) return;
    const branch = await getStore().current().getBranch();
    if (branch.length <= 1) {
      bus.emit("ui:info", { message: "tree: nothing to rewind to yet" });
      return;
    }
    const activeId = getStore().current().getActiveLeaf();
    const items: SelectItem[] = branch.map((e) => ({
      value: e.id,
      label: pickerLabel(e, e.id === activeId),
      description: e.parentId ? `← ${e.parentId.slice(0, 6)}` : "root",
    }));
    const picker = new SelectList(items, 15, selectListTheme());
    const activeIdx = items.findIndex((it) => it.value === activeId);
    if (activeIdx >= 0) picker.setSelectedIndex(activeIdx);

    const close = (): void => {
      pickerOpen = false;
      footerSlot.removeChild(picker);
      tui.setFocus(editor);
      tui.requestRender();
    };

    picker.onSelect = async (item) => {
      const id = item.value;
      close();
      if (id === activeId) return;
      getStore().current().setActiveLeaf(id);
      await applyBranchMessages(ctx, getStore, capture);
      bus.emit("ui:info", { message: `fork: rewound to ${id.slice(0, 6)}` });
      await rebuildChat();
      refreshFooterStats();
    };
    picker.onCancel = close;

    pickerOpen = true;
    footerSlot.addChild(picker);
    tui.setFocus(picker);
    tui.requestRender();
  };

  const openSessionPicker = async (): Promise<void> => {
    if (pickerOpen) return;

    const hint = new InfoLine("↑↓ move · enter: resume · d: delete · esc: cancel");

    const close = (): void => {
      if (activeSessionPicker) footerSlot.removeChild(activeSessionPicker);
      footerSlot.removeChild(hint);
      activeSessionPicker = null;
      activeSessionRepopulate = null;
      activeSessionClose = null;
      pickerOpen = false;
      tui.setFocus(editor);
      tui.requestRender();
    };

    const populate = async (keepIndex?: number): Promise<boolean> => {
      if (activeSessionPicker) footerSlot.removeChild(activeSessionPicker);
      const currentId = getStore().current().id;
      const list = (await getStore().listSessions()).filter((s) => s.id !== currentId);
      if (list.length === 0) {
        activeSessionPicker = null;
        return false;
      }
      const items: SelectItem[] = list.map((s) => ({
        value: s.id,
        label: formatSessionRow(s, false),
      }));
      const picker = new SelectList(items, 15, selectListTheme());
      if (keepIndex !== undefined) {
        picker.setSelectedIndex(Math.min(keepIndex, items.length - 1));
      }
      picker.onSelect = async (item) => {
        const id = item.value;
        close();
        resumeSession(ctx, getStore, capture, id);
        bus.emit("ui:info", { message: `resumed session ${id}` });
        await rebuildChat();
        refreshFooterStats();
      };
      picker.onCancel = close;
      activeSessionPicker = picker;
      footerSlot.addChild(picker);
      tui.setFocus(picker);
      return true;
    };

    footerSlot.addChild(hint);
    if (!(await populate())) {
      footerSlot.removeChild(hint);
      bus.emit("ui:info", { message: "no past sessions in this cwd" });
      return;
    }
    pickerOpen = true;
    activeSessionRepopulate = populate;
    activeSessionClose = close;
    tui.requestRender();
  };

  // ── Keybindings ────────────────────────────────────────────────
  const toggleThinking = (): void => {
    hideThinking = !hideThinking;
    const walk = (node: Container): void => {
      for (const child of node.children) {
        if (child instanceof ThinkingBlock) child.setHidden(hideThinking);
        else if (child instanceof Container) walk(child);
      }
    };
    walk(chat);
    tui.requestRender();
  };

  tui.addInputListener((data) => {
    if (isKeyRelease(data) || isKeyRepeat(data)) return;
    if (matchesKey(data, "escape") && processing) {
      bus.emit("agent:cancel-request", {});
      return { consume: true };
    }
    if (activeSessionPicker && matchesKey(data, "d")) {
      const selected = activeSessionPicker.getSelectedItem();
      if (selected) {
        (async () => {
          const currentId = getStore().current().id;
          const list = await getStore().listSessions();
          const idx = list
            .filter((s) => s.id !== currentId)
            .findIndex((s) => s.id === selected.value);
          try {
            getStore().deleteSession(selected.value);
          } catch (e) {
            bus.emit("ui:error", { message: `delete failed: ${(e as Error).message}` });
            return;
          }
          if (!(await activeSessionRepopulate?.(idx))) activeSessionClose?.();
          tui.requestRender();
        })();
      }
      return { consume: true };
    }
    if (matchesKey(data, "up") && queuedQueries.length > 0 && editor.getText().length === 0) {
      const last = queuedQueries.pop()!;
      renderQueueSlot();
      editor.setText(last);
      tui.requestRender();
      return { consume: true };
    }
    if (matchesKey(data, "ctrl+c")) {
      editor.setText("");
      return { consume: true };
    }
    if (matchesKey(data, "ctrl+d") && editor.getText().length === 0) {
      ctx.quit();
      return { consume: true };
    }
    if (matchesKey(data, "ctrl+t")) {
      toggleThinking();
      return { consume: true };
    }
    if (matchesKey(data, "shift+tab")) {
      const { level, levels, supported } = bus.emitPipe("config:get-thinking", {
        level: "off", levels: [] as string[], supported: true,
      });
      if (supported && levels.length > 0) {
        const next = levels[(levels.indexOf(level) + 1) % levels.length];
        bus.emit("config:set-thinking", { level: next });
      }
      return { consume: true };
    }
    if (matchesKey(data, "ctrl+o")) {
      if (lastToolResult) {
        lastToolResult.toggleExpanded();
        tui.requestRender();
      }
      return { consume: true };
    }
    return undefined;
  });

  tui.start();

  return {
    tui,
    stop: () => { tui.stop(); },
    openTreePicker,
    openSessionPicker,
    rebuildChat,
  };
}

function pickerLabel(e: SessionEntry, isActive: boolean): string {
  const marker = isActive ? "●" : "│";
  const short = e.id.slice(0, 6);
  if (e.type === "session") return `${marker} ${short} session start`;
  if (e.type === "compaction") return `${marker} ${short} ▼ compacted (firstKept=${e.firstKeptId.slice(0, 6)})`;
  const m = e.message;
  const text = typeof m.content === "string" ? m.content.slice(0, 70).replace(/\n/g, " ") : "";
  return `${marker} ${short} ${m.role}: ${text}`;
}
