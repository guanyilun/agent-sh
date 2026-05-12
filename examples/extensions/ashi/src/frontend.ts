import {
  TUI,
  ProcessTerminal,
  Container,
  Editor,
  Loader,
  Spacer,
} from "@earendil-works/pi-tui";
import type { ExtensionContext } from "agent-sh/types";
import { editorTheme, markdownTheme, c } from "./theme.js";
import {
  AssistantMessage,
  ErrorLine,
  InfoLine,
  ToolExecution,
  UserMessage,
} from "./components.js";

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
  editor.onSubmit = (text) => {
    const query = text.trim();
    if (!query) return;
    editor.setText("");
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
      activeAssistant = new AssistantMessage(markdownTheme());
      chat.addChild(new Spacer(1));
      chat.addChild(activeAssistant);
    }
    return activeAssistant;
  };

  const startLoader = () => {
    if (loader) return;
    loader = new Loader(tui, c.accent, c.muted, "thinking…");
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
    chat.addChild(new Spacer(1));
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
    const tool = new ToolExecution(e.title, e.displayDetail);
    activeTools.set(id, tool);
    chat.addChild(tool);
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

  // Ctrl-C: cancel active turn first; on a second press with nothing running, quit.
  // Registered before tui.start() so it sees raw input ahead of the editor.
  let lastCtrlC = 0;
  tui.addInputListener((data) => {
    if (data !== "\x03") return undefined;
    if (processing) {
      bus.emit("agent:cancel-request", {});
      return { consume: true };
    }
    const now = Date.now();
    if (now - lastCtrlC < 1500) {
      ctx.quit();
      return { consume: true };
    }
    lastCtrlC = now;
    chat.addChild(new InfoLine("press Ctrl-C again to exit"));
    tui.requestRender();
    return { consume: true };
  });

  tui.start();

  return {
    tui,
    stop: () => { tui.stop(); },
  };
}
