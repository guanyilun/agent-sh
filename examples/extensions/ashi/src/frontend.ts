import {
  TUI,
  ProcessTerminal,
  Container,
  Editor,
  Loader,
  SelectList,
  Spacer,
  type SelectItem,
  matchesKey,
} from "@earendil-works/pi-tui";
import type { ExtensionContext } from "agent-sh/types";
import { editorTheme, selectListTheme, theme } from "./theme.js";
import {
  AssistantMessage,
  ErrorLine,
  InfoLine,
  ThinkingBlock,
  ToolExecution,
  UserMessage,
} from "./components.js";
import { BusAutocompleteProvider } from "./autocomplete.js";
import { StatusFooter } from "./status-footer.js";
import type { MultiSessionStore } from "./multi-session-store.js";
import type { SessionEntry } from "./session-store.js";
import { formatSessionRow } from "./session-commands.js";
import { resumeSession } from "./session-commands.js";
import { applyBranchMessages } from "./commands.js";
import type { Capture } from "./capture.js";
import { execSync } from "node:child_process";
import { renderDiff } from "agent-sh/utils/diff-renderer.js";
import { renderBoxFrame } from "agent-sh/utils/box-frame.js";

interface DiffStats { added: number; removed: number; isNewFile: boolean; isIdentical: boolean }

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

  tui.addChild(chat);
  tui.addChild(footerSlot);
  tui.addChild(editor);
  tui.addChild(statusFooter);
  tui.setFocus(editor);

  let activeAssistant: AssistantMessage | null = null;
  let activeThinking: ThinkingBlock | null = null;
  const activeTools = new Map<string, ToolExecution>();
  let loader: Loader | null = null;
  let processing = false;
  let hideThinking = false;

  const ensureAssistant = (): AssistantMessage => {
    if (!activeAssistant) {
      activeAssistant = new AssistantMessage();
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
      activeThinking = new ThinkingBlock();
      activeThinking.setHidden(hideThinking);
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

  const replayEntry = (entry: SessionEntry, toolMap: Map<string, ToolExecution>): void => {
    if (entry.type === "session") return;
    if (entry.type === "compaction") {
      chat.addChild(new InfoLine(`▼ compacted (firstKept=${entry.firstKeptId.slice(0, 6)}, ${entry.tokensBefore} tokens)`));
      return;
    }
    const m = entry.message;
    if (m.role === "user") {
      const text = typeof m.content === "string" ? m.content : "";
      if (text.startsWith("[Compacted conversation summary]")) return;
      chat.addChild(new UserMessage(text));
    } else if (m.role === "assistant") {
      const reasoning = readReasoning(m);
      if (reasoning) {
        const tb = new ThinkingBlock();
        tb.appendText(reasoning);
        tb.finalize();
        tb.setHidden(hideThinking);
        chat.addChild(tb);
      }
      const text = typeof m.content === "string" ? m.content : "";
      if (text) {
        const msg = new AssistantMessage();
        msg.appendText(text);
        msg.finalize();
        chat.addChild(msg);
      }
      if (m.tool_calls) {
        for (const tc of m.tool_calls) {
          const id = tc.id ?? "";
          const name = tc.function?.name ?? "tool";
          const exec = new ToolExecution(name, undefined, detailFromArgs(tc.function?.arguments));
          chat.addChild(exec);
          if (id) toolMap.set(id, exec);
        }
      }
    } else if (m.role === "tool") {
      const id = m.tool_call_id ?? "";
      const text = typeof m.content === "string" ? m.content : "";
      const exec = id ? toolMap.get(id) : undefined;
      if (exec) {
        if (text) exec.appendOutput(text);
        exec.complete(0, undefined);
        if (id) toolMap.delete(id);
      } else {
        chat.addChild(new InfoLine(`tool result (no matching call): ${text.slice(0, 80)}`));
      }
    }
  };

  const rebuildChat = async (): Promise<void> => {
    activeAssistant = null;
    activeThinking = null;
    activeTools.clear();
    chat.clear();
    const branch = getStore().current().getBranch();
    const toolMap = new Map<string, ToolExecution>();
    for (const e of branch) replayEntry(e, toolMap);
    tui.requestRender();
  };

  // ── Bus wiring ───────────────────────────────────────────────
  bus.on("agent:query", ({ query }) => {
    chat.addChild(new UserMessage(query));
    activeAssistant = null;
    tui.requestRender();
  });

  bus.on("agent:processing-start", () => {
    processing = true;
    startLoader();
    tui.requestRender();
  });

  bus.on("agent:response-chunk", ({ blocks }) => {
    finalizeThinking();
    const msg = ensureAssistant();
    for (const b of blocks) {
      if (b.type === "text") msg.appendText(b.text);
      else if (b.type === "code-block") msg.appendCodeBlock(b.language, b.code);
    }
    tui.requestRender();
  });

  bus.on("agent:thinking-chunk", ({ text }) => {
    if (activeAssistant) { activeAssistant.finalize(); activeAssistant = null; }
    ensureThinking().appendText(text);
    tui.requestRender();
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
    const tool = new ToolExecution(title, e.kind, detail);
    activeTools.set(id, tool);
    chat.addChild(tool);
    tui.requestRender();
  });

  bus.on("agent:tool-output-chunk", ({ chunk }) => {
    if (activeTools.size === 0) return;
    const last = [...activeTools.values()].pop();
    last?.appendOutput(chunk);
    tui.requestRender();
  });

  bus.on("agent:tool-completed", (e) => {
    const id = e.toolCallId;
    if (!id) return;
    const tool = activeTools.get(id);
    if (!tool) return;
    const summary = e.resultDisplay?.summary;
    const body = e.resultDisplay?.body;
    const ok = e.exitCode === null || e.exitCode === 0;
    if (body?.kind === "diff") {
      const diff = body.diff as DiffStats & Parameters<typeof renderDiff>[0];
      if (!diff.isIdentical) {
        const termW = process.stdout.columns ?? 80;
        const boxW = Math.max(40, termW);
        const contentW = Math.max(20, boxW - 4);
        const diffLines = renderDiff(diff, {
          width: contentW,
          filePath: body.filePath,
          trueColor: true,
          maxLines: 30,
        });
        const inner = diffLines.length > 1 ? ["", ...diffLines.slice(1), ""] : diffLines;
        const framed = renderBoxFrame(inner, {
          width: boxW,
          style: "rounded",
          title: diffFrameTitle(body.filePath, diff),
          bgColor: theme.bgCode(ok ? "toolSuccessBg" : "toolErrorBg"),
        });
        tool.setBody(framed);
      }
    }
    tool.complete(e.exitCode, summary);
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

  let bootBannerShown = false;
  bus.on("agent:info", (info) => {
    if (!bootBannerShown) {
      chat.addChild(new InfoLine(`${info.name}${info.model ? ` · ${info.model}` : ""}`));
      bootBannerShown = true;
    }
    statusFooter.update({
      model: info.model,
      provider: info.provider,
      contextWindow: info.contextWindow,
    });
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

  const openTreePicker = async (): Promise<void> => {
    if (pickerOpen) return;
    const branch = getStore().current().getBranch();
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
      applyBranchMessages(ctx, getStore, capture);
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
    const currentId = getStore().current().id;
    const list = getStore().listSessions().filter((s) => s.id !== currentId);
    if (list.length === 0) {
      bus.emit("ui:info", { message: "no past sessions in this cwd" });
      return;
    }
    const items: SelectItem[] = list.map((s) => ({
      value: s.id,
      label: formatSessionRow(s, false),
    }));
    const picker = new SelectList(items, 15, selectListTheme());

    const close = (): void => {
      pickerOpen = false;
      footerSlot.removeChild(picker);
      tui.setFocus(editor);
      tui.requestRender();
    };

    picker.onSelect = async (item) => {
      const id = item.value;
      close();
      resumeSession(ctx, getStore, capture, id);
      bus.emit("ui:info", { message: `resumed session ${id}` });
      await rebuildChat();
      refreshFooterStats();
    };
    picker.onCancel = close;

    pickerOpen = true;
    footerSlot.addChild(picker);
    tui.setFocus(picker);
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
    bus.emit("ui:info", { message: `thinking: ${hideThinking ? "hidden" : "visible"}` });
    tui.requestRender();
  };

  tui.addInputListener((data) => {
    if (matchesKey(data, "escape") && processing) {
      bus.emit("agent:cancel-request", {});
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
