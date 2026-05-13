import {
  TUI,
  ProcessTerminal,
  Container,
  Editor,
  Loader,
  SelectList,
  type SelectItem,
  matchesKey,
} from "@earendil-works/pi-tui";
import type { ExtensionContext } from "agent-sh/types";
import { editorTheme, selectListTheme, theme } from "./theme.js";
import {
  AssistantMessage,
  ErrorLine,
  InfoLine,
  ToolExecution,
  UserMessage,
} from "./components.js";
import { BusAutocompleteProvider } from "./autocomplete.js";
import { StatusFooter } from "./status-footer.js";
import type { MultiSessionStore } from "./multi-session-store.js";
import type { AgentMessage, SessionEntry, MessageEntry, CompactionEntry } from "./session-store.js";
import { formatSessionRow } from "./session-commands.js";
import { resumeSession } from "./session-commands.js";
import { applyBranchMessages } from "./commands.js";
import type { Capture } from "./capture.js";

const fgAccent = (t: string): string => theme.fg("accent", t);
const fgMuted = (t: string): string => theme.fg("muted", t);

interface ToolCallShape {
  id?: string;
  function?: { name: string; arguments?: string };
}

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
  store: () => MultiSessionStore,
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
  statusFooter.update({ cwd: ctx.call("cwd") as string });
  let compactions = 0;
  const refreshFooterStats = (): void => {
    const tokens = ctx.call("conversation:estimate-prompt-tokens") as number | undefined;
    statusFooter.update({ tokens: tokens ?? 0 });
  };

  tui.addChild(chat);
  tui.addChild(footerSlot);
  tui.addChild(editor);
  tui.addChild(statusFooter);
  tui.setFocus(editor);

  // ── Active render targets ────────────────────────────────────
  let activeAssistant: AssistantMessage | null = null;
  const activeTools = new Map<string, ToolExecution>(); // keyed by toolCallId
  let loader: Loader | null = null;
  let processing = false;

  const ensureAssistant = (): AssistantMessage => {
    if (!activeAssistant) {
      activeAssistant = new AssistantMessage();
      chat.addChild(activeAssistant);
    }
    return activeAssistant;
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

  /** Render one SessionEntry as chat UI components. Walks user/assistant/
   *  tool messages, pairing tool_calls with their results by id. */
  const replayEntry = (entry: SessionEntry, toolMap: Map<string, ToolExecution>): void => {
    if (entry.type === "session") return;
    if (entry.type === "compaction") {
      const c = entry as CompactionEntry;
      chat.addChild(new InfoLine(`▼ compacted (firstKept=${c.firstKeptId.slice(0, 6)}, ${c.tokensBefore} tokens)`));
      return;
    }
    const m = (entry as MessageEntry).message;
    if (m.role === "user") {
      const text = typeof m.content === "string" ? m.content : "";
      if (text.startsWith("[")) {
        // Synthetic preamble (e.g. nuclear preamble); skip
        return;
      }
      chat.addChild(new UserMessage(text));
    } else if (m.role === "assistant") {
      const text = typeof m.content === "string" ? m.content : "";
      if (text) {
        const msg = new AssistantMessage();
        msg.appendText(text);
        msg.finalize();
        chat.addChild(msg);
      }
      const tcs = (m as { tool_calls?: ToolCallShape[] }).tool_calls;
      if (Array.isArray(tcs)) {
        for (const tc of tcs) {
          const id = tc.id ?? "";
          const name = tc.function?.name ?? "tool";
          const detail = detailFromArgs(tc.function?.arguments);
          const exec = new ToolExecution(name, undefined, detail);
          chat.addChild(exec);
          if (id) toolMap.set(id, exec);
        }
      }
    } else if (m.role === "tool") {
      const id = (m as { tool_call_id?: string }).tool_call_id ?? "";
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
    activeTools.clear();
    chat.clear();
    const branch = store().current().getBranch();
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
    const msg = ensureAssistant();
    for (const b of blocks) {
      if (b.type === "text") msg.appendText(b.text);
      else if (b.type === "code-block") msg.appendCodeBlock(b.language, b.code);
    }
    tui.requestRender();
  });

  bus.on("agent:thinking-chunk", () => { /* loader covers this */ });

  bus.on("agent:tool-started", (e) => {
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
    tool.complete(e.exitCode, summary);
    activeTools.delete(id);
    tui.requestRender();
  });

  bus.on("agent:processing-done", () => {
    processing = false;
    stopLoader();
    if (activeAssistant) activeAssistant.finalize();
    refreshFooterStats();
    tui.requestRender();
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
    chat.addChild(new InfoLine(`${info.name}${info.model ? ` · ${info.model}` : ""}`));
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
    const branch = store().current().getBranch();
    if (branch.length <= 1) {
      bus.emit("ui:info", { message: "tree: nothing to rewind to yet" });
      return;
    }
    const activeId = store().current().getActiveLeaf();
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
      store().current().setActiveLeaf(id);
      applyBranchMessages(ctx, store, capture);
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
    const list = store().listSessions();
    if (list.length === 0) {
      bus.emit("ui:info", { message: "no past sessions in this cwd" });
      return;
    }
    const currentId = store().current().id;
    const items: SelectItem[] = list.map((s) => ({
      value: s.id,
      label: formatSessionRow(s, s.id === currentId),
      description: s.id,
    }));
    const picker = new SelectList(items, 15, selectListTheme());
    const currentIdx = items.findIndex((it) => it.value === currentId);
    if (currentIdx >= 0) picker.setSelectedIndex(currentIdx);

    const close = (): void => {
      pickerOpen = false;
      footerSlot.removeChild(picker);
      tui.setFocus(editor);
      tui.requestRender();
    };

    picker.onSelect = async (item) => {
      const id = item.value;
      close();
      if (id === currentId) return;
      resumeSession(ctx, store, capture, id);
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
  if (e.type === "compaction") {
    const c = e as CompactionEntry;
    return `${marker} ${short} ▼ compacted (firstKept=${c.firstKeptId.slice(0, 6)})`;
  }
  const m = (e as MessageEntry).message;
  const text = typeof m.content === "string" ? m.content.slice(0, 70).replace(/\n/g, " ") : "";
  return `${marker} ${short} ${m.role}: ${text}`;
}
