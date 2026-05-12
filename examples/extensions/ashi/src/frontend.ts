import {
  TUI,
  ProcessTerminal,
  Container,
  Editor,
  Loader,
  matchesKey,
} from "@earendil-works/pi-tui";
import type { ExtensionContext } from "agent-sh/types";
import { editorTheme, theme } from "./theme.js";
import {
  AssistantMessage,
  ErrorLine,
  InfoLine,
  ToolExecution,
  UserMessage,
} from "./components.js";
import { BusAutocompleteProvider } from "./autocomplete.js";

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
}

export function mountAshi(ctx: ExtensionContext): AshiHandle {
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

  tui.addChild(chat);
  tui.addChild(footerSlot);
  tui.addChild(editor);
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
    tui.requestRender();
  });

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

  tui.start();

  return {
    tui,
    stop: () => { tui.stop(); },
  };
}
