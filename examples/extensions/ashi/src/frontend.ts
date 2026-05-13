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
import type { NuclearEntry } from "agent-sh/core";
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
import type { SessionTree } from "./leaf-tracking-tree-history.js";
import type { MultiSessionTreeAdapter } from "./multi-session-tree-history.js";
import { formatSessionRow } from "./session-commands.js";

const fgAccent = (t: string): string => theme.fg("accent", t);
const fgMuted = (t: string): string => theme.fg("muted", t);

/** Tools without a `formatCall` rely on the renderer to surface the
 *  meaningful bit of their rawInput (the command, the file path, the
 *  search pattern). Mirrors src/extensions/tui-renderer.ts extractDetail. */
function detailFor(
  rawInput: unknown,
  locations: { path: string; line?: number | null }[] | undefined,
  cwd: string,
): string {
  const home = process.env.HOME;
  const relativize = (fp: string): string => {
    if (fp.startsWith(`${cwd}/`)) return fp.slice(cwd.length + 1);
    if (home && fp.startsWith(`${home}/`)) return `~/${fp.slice(home.length + 1)}`;
    return fp;
  };
  if (locations && locations.length > 0) {
    const loc = locations[0]!;
    const fp = relativize(loc.path);
    return loc.line ? `${fp}:${loc.line}` : fp;
  }
  const raw = rawInput as Record<string, unknown> | undefined;
  if (!raw) return "";
  if (typeof raw.command === "string") return `$ ${raw.command}`;
  if (typeof raw.pattern === "string") return raw.pattern;
  if (typeof raw.path === "string") return relativize(raw.path);
  if (typeof raw.query === "string") return `"${raw.query}"`;
  return "";
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
  tree: SessionTree,
  sessions: MultiSessionTreeAdapter | null,
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
    statusFooter.update({ leaf: tree.getActiveLeaf(), tokens: tokens ?? 0 });
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

  const startLoader = () => {
    if (loader) return;
    loader = new Loader(tui, fgAccent, fgMuted, "thinking…");
    footerSlot.addChild(loader);
  };
  const stopLoader = () => {
    if (!loader) return;
    loader.stop();
    footerSlot.removeChild(loader);
    loader = null;
  };

  const replayEntry = (entry: NuclearEntry): void => {
    const text = entry.body ?? entry.sum;
    switch (entry.kind) {
      case "user":
        chat.addChild(new UserMessage(text));
        break;
      case "agent": {
        const msg = new AssistantMessage();
        msg.appendText(text);
        msg.finalize();
        chat.addChild(msg);
        break;
      }
      case "tool":
      case "error": {
        const tool = new ToolExecution(entry.tool ?? "tool", undefined, "");
        if (entry.body) tool.appendOutput(entry.body);
        tool.complete(entry.kind === "error" ? 1 : 0, entry.sum);
        chat.addChild(tool);
        break;
      }
      case "compaction":
        chat.addChild(new InfoLine(`▼ ${entry.sum}`));
        break;
      case "session":
        break;
      default:
        chat.addChild(new InfoLine(entry.sum));
    }
  };

  const rebuildChat = async (): Promise<void> => {
    activeAssistant = null;
    activeTools.clear();
    chat.clear();
    const branch = await tree.getBranch(tree.getActiveLeaf());
    for (const e of branch) replayEntry(e);
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

  bus.on("agent:thinking-chunk", () => {
    // Thinking is currently not surfaced as its own component; keep
    // the loader spinning. A future ThinkingPanel could subscribe here.
  });

  bus.on("agent:tool-started", (e) => {
    const id = e.toolCallId ?? `${e.title}-${Date.now()}`;
    // Kernel composes title as "<toolName>: <args.description>" when the
    // tool's args carry a description. The command/path shown right next
    // to the title already conveys what the call is doing — strip the
    // suffix so the header reads as "bash" / "read_file" / etc.
    const title = e.title.split(":")[0]!.trim();
    const detail = e.displayDetail || detailFor(e.rawInput, e.locations, ctx.call("cwd"));
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

  // Match pi-coding-agent's keybindings:
  //   Esc    — cancel active turn (when autocomplete is closed, which the
  //            editor handles itself; we only fire during processing)
  //   Ctrl+C — clear editor
  //   Ctrl+D — quit when editor is empty
  // matchesKey() covers both legacy bytes (\x03, \x04, \x1b) and the Kitty
  // keyboard protocol CSI encodings used by Ghostty/Kitty/iTerm. Direct byte
  // comparison would miss Kitty-mode terminals.
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

  let pickerOpen = false;
  const openTreePicker = async (): Promise<void> => {
    if (pickerOpen) return;
    const entries = await tree.getTree();
    if (entries.length === 0) {
      bus.emit("ui:info", { message: "tree: empty" });
      return;
    }
    const activeLeaf = tree.getActiveLeaf();
    const branchSeqs = new Set((await tree.getBranch(activeLeaf)).map((e) => e.seq));
    const items: SelectItem[] = entries.map((e) => ({
      value: String(e.seq),
      label: `${e.seq === activeLeaf ? "●" : branchSeqs.has(e.seq) ? "│" : " "} #${e.seq} ${e.sum}`,
      description: e.parentSeq != null ? `← #${e.parentSeq}` : "root",
    }));

    const picker = new SelectList(items, 15, selectListTheme());
    const activeIdx = items.findIndex((it) => it.value === String(activeLeaf));
    if (activeIdx >= 0) picker.setSelectedIndex(activeIdx);

    const close = (): void => {
      pickerOpen = false;
      footerSlot.removeChild(picker);
      tui.setFocus(editor);
      tui.requestRender();
    };

    picker.onSelect = async (item) => {
      const seq = parseInt(item.value, 10);
      close();
      if (seq === activeLeaf) return;
      tree.setLeaf(seq);
      const snapshot = tree.loadSnapshot(seq);
      if (snapshot && snapshot.length > 0) {
        ctx.call("conversation:replace-messages", snapshot);
        bus.emit("ui:info", { message: `fork: restored ${snapshot.length} messages from snapshot @ #${seq}` });
      } else {
        bus.emit("ui:info", { message: `fork: next turn parents from #${seq} (no snapshot — agent context not rewound)` });
      }
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
    if (!sessions) {
      bus.emit("ui:error", { message: "resume: not supported by the active history adapter" });
      return;
    }
    const list = await sessions.listSessions();
    if (list.length === 0) {
      bus.emit("ui:info", { message: "no past sessions in this cwd" });
      return;
    }
    const currentId = sessions.getCurrentId();
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
      sessions.switchTo(id);
      const branch = await sessions.readRecent();
      const nextSeq = (branch.length === 0 ? 0 : Math.max(...branch.map((e) => e.seq))) + 1;
      ctx.call("conversation:reset-for-session", nextSeq);
      const snapshot = sessions.loadSnapshot(sessions.getActiveLeaf());
      if (snapshot && snapshot.length > 0) {
        ctx.call("conversation:replace-messages", snapshot);
        bus.emit("ui:info", { message: `resumed session ${id} (${snapshot.length} messages)` });
      } else {
        ctx.call("conversation:replace-messages", []);
        bus.emit("ui:info", { message: `resumed session ${id} (no snapshot — empty context)` });
      }
      await rebuildChat();
      refreshFooterStats();
    };
    picker.onCancel = close;

    pickerOpen = true;
    footerSlot.addChild(picker);
    tui.setFocus(picker);
    tui.requestRender();
  };

  tui.start();

  return {
    tui,
    stop: () => { tui.stop(); },
    openTreePicker,
    openSessionPicker,
    rebuildChat,
  };
}
