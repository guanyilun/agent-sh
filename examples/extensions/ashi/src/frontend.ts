import type { ExtensionContext } from "agent-sh/types";
import { theme } from "./theme.js";
import type {
  KeyEvent,
  LoaderView,
  RenderNode,
  Renderer,
  SelectItem,
  SelectView,
  ToolCallView,
  ToolResultView,
} from "./renderer.js";
import { ErrorLine, InfoLine } from "./chat/lines.js";
import { AssistantMessage } from "./chat/assistant.js";
import { ThinkingBlock } from "./chat/thinking.js";
import { UserMessage } from "./chat/user-message.js";
import { ToolGroup } from "./chat/tool-group.js";
import { createToolHookResolver } from "./hooks.js";
import { loadGroupMaxVisible } from "./display-config.js";
import { classifySubmit, deriveChangeHandlerResult } from "./shell-mode.js";
import { UserShellIntents } from "./user-shell-intents.js";
import { BusAutocompleteProvider } from "./autocomplete.js";
import { StatusFooter } from "./status-footer.js";
import type { MultiSessionStore } from "./multi-session-store.js";
import { stripContextWrappers, type SessionEntry } from "agent-sh/session-store";
import { formatSessionRow } from "./session-commands.js";
import { resumeSession } from "./session-commands.js";
import { applyBranchMessages } from "./commands.js";
import type { Capture } from "./capture.js";
import { execSync } from "node:child_process";
import { renderDiff, detectLanguage, highlightLine } from "agent-sh/utils/diff-renderer.js";
import { renderBoxFrame } from "agent-sh/utils/box-frame.js";

const GROUPABLE_KINDS = new Set(["read", "search"]);
const TOOL_KIND: Record<string, string> = {
  read_file: "read", ls: "read",
  grep: "search", glob: "search",
};

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
    if (typeof args.source === "string") {
      const compact = args.source.replace(/\s+/g, " ").trim();
      return compact.length > 80 ? compact.slice(0, 77) + "…" : compact;
    }
  } catch { /* fall through */ }
  return "";
}

/** resultDisplay isn't persisted, so /resume rebuilds the "16 entries" / "117
 *  lines" hints from saved tool output. */
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
  stop: () => void;
  openTreePicker: () => Promise<void>;
  openSessionPicker: () => Promise<void>;
  rebuildChat: () => Promise<void>;
}

export function mountAshi(
  ctx: ExtensionContext,
  getStore: () => MultiSessionStore,
  capture: Capture,
  renderer: Renderer,
): AshiHandle {
  const { bus } = ctx;
  const app = renderer.mount();
  const input = app.input;

  const statusFooter = new StatusFooter(app.status, renderer.measureWidth);

  let shellMode = false;
  let pendingPrivate = false;
  const baseAutocomplete = new BusAutocompleteProvider(bus);
  input.setAutocompleteProvider({
    getSuggestions: async (lines, line, col) =>
      shellMode ? null : baseAutocomplete.getSuggestions(lines, line, col),
    applyCompletion: baseAutocomplete.applyCompletion.bind(baseAutocomplete),
  });

  const defaultBorderColor = input.defaultBorderColor;
  const shellBorderColor = (t: string): string => theme.fg("bashMode", t);
  const privateBorderColor = (t: string): string => theme.fg("bashModePrivate", t);
  const refreshShellChrome = (): void => {
    input.setBorderColor(shellMode
      ? (pendingPrivate ? privateBorderColor : shellBorderColor)
      : defaultBorderColor);
    input.invalidate();
    statusFooter.update({
      shellMode: shellMode ? (pendingPrivate ? "private" : "on") : "off",
    });
    app.requestRender();
  };
  const setShellMode = (on: boolean): void => {
    if (shellMode === on) return;
    shellMode = on;
    if (!on) pendingPrivate = false;
    refreshShellChrome();
  };
  const setPendingPrivate = (on: boolean): void => {
    if (pendingPrivate === on) return;
    pendingPrivate = on;
    refreshShellChrome();
  };

  input.onChange((text) => {
    const r = deriveChangeHandlerResult(shellMode, pendingPrivate, text);
    // Order matters: setText fires onChange synchronously, and the recursive
    // call must see the new mode/private values or it re-runs the entry
    // transition and clobbers the just-set state.
    if (r.mode !== shellMode) setShellMode(r.mode);
    setPendingPrivate(r.pendingPrivate);
    if (r.replaceText !== undefined) input.setText(r.replaceText);
  });

  input.onSubmit((text) => {
    const action = classifySubmit(text, shellMode, pendingPrivate);
    if (action.kind === "noop") return;
    input.setText("");
    switch (action.kind) {
      case "shell":
        submitShell(action.line, { private: action.private });
        setPendingPrivate(false);
        return;
      case "command":
        bus.emit("command:execute", { name: action.name, args: action.args });
        return;
      case "agent":
        if (processing) {
          queuedQueries.push(action.query);
          renderQueueSlot();
          app.requestRender();
          return;
        }
        bus.emit("agent:submit", { query: action.query });
        return;
    }
  });

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

  // A typed list parallel to the scrollback nodes. Group-merge / thinking-toggle
  // / expand-all inspect these controllers instead of reflecting over the
  // renderer's node tree.
  type ChatEntry =
    | { t: "group"; group: ToolGroup }
    | { t: "thinking"; ctrl: ThinkingBlock }
    | { t: "assistant"; ctrl: AssistantMessage }
    | { t: "pair"; result: ToolResultView }
    | { t: "plain" };
  const chatEntries: ChatEntry[] = [];
  const appendEntry = (node: RenderNode, entry: ChatEntry): void => {
    app.scrollback.addChild(node);
    chatEntries.push(entry);
  };
  const clearChat = (): void => {
    app.scrollback.clear();
    chatEntries.length = 0;
  };

  interface ToolPair { call: ToolCallView; result: ToolResultView; startedAt: number }
  type LiveToolEntry = { kind: "pair"; pair: ToolPair } | { kind: "group"; group: ToolGroup };

  let activeAssistant: AssistantMessage | null = null;
  let activeThinking: ThinkingBlock | null = null;
  const activeTools = new Map<string, LiveToolEntry>();
  const groupMaxVisible = loadGroupMaxVisible();

  /** Visible thinking acts as a hard separator; hidden thinking is transparent. */
  const findMergeableGroup = (kind: string): ToolGroup | null => {
    for (let i = chatEntries.length - 1; i >= 0; i--) {
      const e = chatEntries[i]!;
      if (e.t === "group") return e.group.kind === kind ? e.group : null;
      if (e.t === "thinking" && hideThinking) continue;
      if (e.t === "assistant" && !e.ctrl.hasContent()) continue;
      return null;
    }
    return null;
  };
  let loader: LoaderView | null = null;
  let processing = false;
  const queuedQueries: string[] = [];
  const queuedShellLines: { line: string; private: boolean }[] = [];
  const pendingUserShell = new UserShellIntents();

  const renderQueueSlot = (): void => {
    app.queueSlot.clear();
    for (const item of queuedShellLines) {
      const oneLine = item.line.replace(/\s+/g, " ");
      const preview = oneLine.length > 80 ? oneLine.slice(0, 77) + "…" : oneLine;
      const tag = item.private ? "shell·private" : "shell";
      app.queueSlot.addChild(new InfoLine(renderer, `↳ ${tag}: ${preview}`).node);
    }
    for (const q of queuedQueries) {
      const oneLine = q.replace(/\s+/g, " ");
      const preview = oneLine.length > 80 ? oneLine.slice(0, 77) + "…" : oneLine;
      app.queueSlot.addChild(new InfoLine(renderer, `↳ queued: ${preview}`).node);
    }
  };

  const submitShell = (line: string, opts?: { private?: boolean }): void => {
    if (processing) {
      queuedShellLines.push({ line, private: !!opts?.private });
      renderQueueSlot();
      app.requestRender();
      return;
    }
    pendingUserShell.push({ private: !!opts?.private });
    if (opts?.private) bus.emit("shell:user-exec-exclude-next", {});
    bus.emit("shell:pty-write", { data: line + "\n" });
  };
  let hideThinking = true;

  const renderState = (): { state: Record<string, unknown>; invalidate: () => void } => ({
    state: {},
    invalidate: () => app.requestRender(),
  });

  const tools = createToolHookResolver(ctx, renderer);

  const renderUserMessage = (text: string): RenderNode =>
    (ctx.call("ashi:render-user-message", { text, ...renderState() }) as UserMessage).node;

  const renderAssistantLive = (): AssistantMessage =>
    ctx.call("ashi:render-assistant", { text: "", ...renderState() }) as AssistantMessage;

  const renderAssistantFinal = (text: string): AssistantMessage =>
    ctx.call("ashi:render-assistant", { text, ...renderState() }) as AssistantMessage;

  const renderThinkingLive = (): ThinkingBlock =>
    ctx.call("ashi:render-thinking", { text: "", hidden: hideThinking, ...renderState() }) as ThinkingBlock;

  const renderThinkingFinal = (text: string): ThinkingBlock =>
    ctx.call("ashi:render-thinking", { text, hidden: hideThinking, ...renderState() }) as ThinkingBlock;

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
      appendEntry(activeAssistant.node, { t: "assistant", ctrl: activeAssistant });
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
      appendEntry(activeThinking.node, { t: "thinking", ctrl: activeThinking });
    }
    return activeThinking;
  };

  const startLoader = (): void => {
    if (loader) return;
    loader = app.createLoader("thinking…", fgAccent, fgMuted);
    app.footerSlot.addChild(loader.node);
  };
  const stopLoader = (): void => {
    if (!loader) return;
    loader.stop();
    app.footerSlot.removeChild(loader.node);
    loader = null;
  };

  type ReplayEntry =
    | { kind: "pair"; pair: ToolPair; name: string }
    | { kind: "group"; group: ToolGroup; name: string };

  const replayEntry = (entry: SessionEntry, toolMap: Map<string, ReplayEntry>): void => {
    if (entry.type === "session") return;
    if (entry.type === "compaction") {
      appendEntry(
        new InfoLine(renderer, `▼ compacted (firstKept=${entry.firstKeptId.slice(0, 6)}, ${entry.tokensBefore} tokens)`).node,
        { t: "plain" },
      );
      return;
    }
    if (entry.type === "shell-exchange") {
      const name = entry.private ? "user_bash_private" : "user_bash";
      const pair = renderToolPair({
        toolCallId: `user-shell-replay-${entry.id}`, name, title: name,
        kind: "bash", displayDetail: entry.command, rawInput: { command: entry.command },
      });
      appendEntry(pair.call.node, { t: "plain" });
      appendEntry(pair.result.node, { t: "pair", result: pair.result });
      if (entry.output) pair.result.appendChunk(entry.output);
      pair.result.finalize({ exitCode: entry.exitCode });
      pair.call.setStatus({ exitCode: entry.exitCode, elapsedMs: 0 });
      appendEntry(renderer.spacer(1), { t: "plain" });
      return;
    }
    const m = entry.message;
    if (m.role === "user") {
      const raw = typeof m.content === "string" ? m.content : "";
      if (raw.startsWith("[Compacted conversation summary]")) return;
      appendEntry(renderUserMessage(stripContextWrappers(raw)), { t: "plain" });
    } else if (m.role === "assistant") {
      const reasoning = readReasoning(m);
      if (reasoning) {
        const tb = renderThinkingFinal(reasoning);
        appendEntry(tb.node, { t: "thinking", ctrl: tb });
      }
      const text = typeof m.content === "string" ? m.content : "";
      if (text) {
        const am = renderAssistantFinal(text);
        appendEntry(am.node, { t: "assistant", ctrl: am });
      }
      if (m.tool_calls) {
        for (const tc of m.tool_calls) {
          if (tc.type !== "function") continue;
          const id = tc.id ?? "";
          const name = tc.function.name ?? "tool";
          const kind = TOOL_KIND[name];
          if (kind && GROUPABLE_KINDS.has(kind)) {
            const mergeable = findMergeableGroup(kind);
            const group = mergeable
              ?? (() => { const g = new ToolGroup(renderer, kind, groupMaxVisible); appendEntry(g.node, { t: "group", group: g }); return g; })();
            group.addCall(id, name, detailFromArgs(tc.function.arguments));
            if (id) toolMap.set(id, { kind: "group", group, name });
            continue;
          }
          const pair = renderToolPair({
            toolCallId: id, name, title: name, kind: undefined,
            displayDetail: detailFromArgs(tc.function.arguments),
            rawInput: tc.function.arguments,
          });
          appendEntry(pair.call.node, { t: "plain" });
          appendEntry(pair.result.node, { t: "pair", result: pair.result });
          if (id) toolMap.set(id, { kind: "pair", pair, name });
        }
      }
    } else if (m.role === "tool") {
      const id = m.tool_call_id ?? "";
      const text = typeof m.content === "string" ? m.content : "";
      const found = id ? toolMap.get(id) : undefined;
      if (!found) {
        appendEntry(new InfoLine(renderer, `tool result (no matching call): ${text.slice(0, 80)}`).node, { t: "plain" });
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
    clearChat();
    const branch = getStore().current().getBranch();
    const toolMap = new Map<string, ReplayEntry>();
    for (const e of branch) replayEntry(e, toolMap);
    appendEntry(renderer.spacer(1), { t: "plain" });
    app.requestRender();
  };

  bus.on("agent:query", ({ query }) => {
    appendEntry(renderUserMessage(query), { t: "plain" });
    activeAssistant = null;
    app.requestRender();
  });

  bus.on("agent:processing-start", () => {
    processing = true;
    startLoader();
    app.requestRender();
  });

  /** Drop the live assistant so subsequent text starts fresh markdown below the image. */
  const appendImage = (data: Buffer): void => {
    const img = renderer.image(data);
    if (!img) return;
    if (activeAssistant) { activeAssistant.finalize(); activeAssistant = null; }
    appendEntry(img, { t: "plain" });
  };

  /** tui-renderer normally owns this hook; ashi disables it and provides its own. */
  ctx.define("render:image", (data: Buffer) => {
    appendImage(data);
    app.requestRender();
  });

  bus.on("agent:response-chunk", ({ blocks }) => {
    finalizeThinking();
    for (const b of blocks) {
      if (b.type === "text") ensureAssistant().appendText(b.text);
      else if (b.type === "code-block") ensureAssistant().appendCodeBlock(b.language, b.code);
      else if (b.type === "image") appendImage(b.data);
    }
    app.requestRender();
  });

  bus.on("agent:thinking-chunk", ({ text }) => {
    if (activeAssistant) { activeAssistant.finalize(); activeAssistant = null; }
    ensureThinking().appendText(text);
    app.requestRender();
  });

  bus.on("agent:tool-started", (e) => {
    finalizeThinking();
    if (activeAssistant) {
      activeAssistant.finalize();
      activeAssistant = null;
    }
    const id = e.toolCallId ?? `${e.title}-${Date.now()}`;
    const title = e.title.split(":")[0]!.trim();
    const lookupName = e.name ?? title;
    const detail = e.displayDetail || detailFromArgs(
      typeof e.rawInput === "string" ? e.rawInput : JSON.stringify(e.rawInput ?? {})
    );

    const kind = e.kind ?? "";
    if (GROUPABLE_KINDS.has(kind)) {
      const mergeable = findMergeableGroup(kind);
      const group = mergeable
        ?? (() => { const g = new ToolGroup(renderer, kind, groupMaxVisible); appendEntry(g.node, { t: "group", group: g }); return g; })();
      group.addCall(id, lookupName, detail);
      activeTools.set(id, { kind: "group", group });
      app.requestRender();
      return;
    }

    const pair = renderToolPair({
      toolCallId: id, name: lookupName, title, kind: e.kind,
      displayDetail: detail, rawInput: e.rawInput,
    });
    activeTools.set(id, { kind: "pair", pair });
    appendEntry(pair.call.node, { t: "plain" });
    appendEntry(pair.result.node, { t: "pair", result: pair.result });
    app.requestRender();
  });

  bus.on("agent:tool-output-chunk", ({ chunk }) => {
    for (const entry of [...activeTools.values()].reverse()) {
      if (entry.kind === "pair") {
        entry.pair.result.appendChunk(chunk);
        app.requestRender();
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
      app.requestRender();
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
    app.requestRender();
  });

  // agent:tool-* listeners already render agent-issued bash; the shell:* path
  // is only for user-issued `!` commands.
  let agentShellActive = false;
  let shellForegroundBusy = false;
  bus.on("shell:agent-exec-start", () => { agentShellActive = true; });
  bus.on("shell:agent-exec-done", () => { agentShellActive = false; });
  bus.on("shell:foreground-busy", ({ busy }) => { shellForegroundBusy = busy; });

  let activeUserShell: { pair: ToolPair; command: string; isPrivate: boolean } | null = null;
  bus.on("shell:command-start", ({ command }) => {
    if (agentShellActive) return;
    const intent = pendingUserShell.consume();
    if (!intent) return;
    finalizeThinking();
    if (activeAssistant) { activeAssistant.finalize(); activeAssistant = null; }
    const isPrivate = intent.private;
    const name = isPrivate ? "user_bash_private" : "user_bash";
    const pair = renderToolPair({
      toolCallId: `user-shell-${Date.now()}`, name, title: name,
      kind: "bash", displayDetail: command, rawInput: { command },
    });
    activeUserShell = { pair, command, isPrivate };
    appendEntry(pair.call.node, { t: "plain" });
    appendEntry(pair.result.node, { t: "pair", result: pair.result });
    app.requestRender();
  });

  bus.on("shell:command-done", ({ output, cwd, exitCode }) => {
    const active = activeUserShell;
    if (!active) return;
    const { pair, command, isPrivate } = active;
    if (output) pair.result.appendChunk(output);
    pair.call.setStatus({ exitCode, elapsedMs: Date.now() - pair.startedAt });
    pair.result.finalize({ exitCode });
    activeUserShell = null;
    appendEntry(renderer.spacer(1), { t: "plain" });
    app.requestRender();
    void getStore().current().appendShellExchange({
      command, output: output ?? "", exitCode, cwd,
      ...(isPrivate ? { private: true } : {}),
    });
    getStore().markLastSession();
  });

  bus.on("agent:processing-done", () => {
    processing = false;
    stopLoader();
    finalizeThinking();
    if (activeAssistant) activeAssistant.finalize();
    appendEntry(renderer.spacer(1), { t: "plain" });
    refreshFooterStats();
    refreshBranch();
    // Shell queue drains first so its output lands in the next turn's <shell_events>.
    while (queuedShellLines.length > 0) {
      const item = queuedShellLines.shift()!;
      pendingUserShell.push({ private: item.private });
      if (item.private) bus.emit("shell:user-exec-exclude-next", {});
      bus.emit("shell:pty-write", { data: item.line + "\n" });
    }
    const next = queuedQueries.shift();
    if (next !== undefined) {
      renderQueueSlot();
      bus.emit("agent:submit", { query: next });
    } else {
      renderQueueSlot();
    }
    app.requestRender();
  });

  bus.on("agent:usage", (u) => {
    if (u.prompt_tokens > 0) {
      statusFooter.update({ tokens: u.prompt_tokens });
      app.requestRender();
    }
  });

  bus.on("agent:cancelled", () => {
    processing = false;
    stopLoader();
    appendEntry(new InfoLine(renderer, "cancelled").node, { t: "plain" });
    app.requestRender();
  });

  bus.on("agent:error", ({ message }) => {
    processing = false;
    stopLoader();
    appendEntry(new ErrorLine(renderer, message).node, { t: "plain" });
    app.requestRender();
  });

  bus.on("ui:info", ({ message }) => {
    appendEntry(new InfoLine(renderer, message).node, { t: "plain" });
    app.requestRender();
  });

  bus.on("ui:error", ({ message }) => {
    appendEntry(new ErrorLine(renderer, message).node, { t: "plain" });
    app.requestRender();
  });

  bus.on("agent:info", (info) => {
    statusFooter.update({
      model: info.model,
      provider: info.provider,
      contextWindow: info.contextWindow,
    });
    refreshThinking();
    app.requestRender();
  });

  bus.on("config:changed", () => {
    refreshThinking();
    app.requestRender();
  });

  bus.on("conversation:after-compact", () => {
    compactions++;
    statusFooter.update({ compactions });
    refreshFooterStats();
    app.requestRender();
  });

  refreshFooterStats();

  let pickerOpen = false;
  let activeSessionPicker: SelectView | null = null;
  let activeSessionRepopulate: ((keepIndex?: number) => boolean) | null = null;
  let activeSessionClose: (() => void) | null = null;

  const openTreePicker = async (): Promise<void> => {
    if (pickerOpen) return;
    const store = getStore().current();
    const all = store.getAllEntries();
    const byId = new Map(all.map((e) => [e.id, e]));
    const rawChildren = new Map<string, string[]>();
    for (const e of all) {
      if (!e.parentId) continue;
      const kids = rawChildren.get(e.parentId) ?? [];
      kids.push(e.id);
      rawChildren.set(e.parentId, kids);
    }
    for (const ids of rawChildren.values()) {
      ids.sort((a, b) => (byId.get(a)?.timestamp ?? 0) - (byId.get(b)?.timestamp ?? 0));
    }

    const isVisible = (e: SessionEntry): boolean => {
      if (e.type === "message" && e.message.role === "user") return true;
      return (rawChildren.get(e.id)?.length ?? 0) === 0;
    };
    const visibleChildren = (id: string): string[] => {
      const out: string[] = [];
      const stack = [...(rawChildren.get(id) ?? [])];
      while (stack.length > 0) {
        const cid = stack.shift()!;
        const e = byId.get(cid);
        if (e && isVisible(e)) out.push(cid);
        else stack.unshift(...(rawChildren.get(cid) ?? []));
      }
      return out;
    };

    const activeLeaf = store.getActiveLeaf();
    type Row = { id: string; entry: SessionEntry; prefix: string; kind: "msg" | "tip" };
    const rows: Row[] = [];
    const walk = (id: string, lineage: string[], isBranchChild: boolean): void => {
      const e = byId.get(id);
      if (!e) return;
      if (isVisible(e)) {
        const cols = isBranchChild
          ? [...lineage.slice(0, -1), lineage[lineage.length - 1] === "│" ? "├" : "└"]
          : lineage;
        const isUserMsg = e.type === "message" && e.message.role === "user";
        rows.push({ id: e.id, entry: e, prefix: cols.join(" "), kind: isUserMsg ? "msg" : "tip" });
      }
      const kids = visibleChildren(id);
      if (kids.length === 0) return;
      if (kids.length === 1) {
        const only = byId.get(kids[0]!);
        const isTip = !!only && !(only.type === "message" && only.message.role === "user");
        if (isTip) {
          // Render the tip as a branch-child so it gets a `└` connector at
          // a deeper indent, visually "the next node in this branch."
          walk(kids[0]!, [...lineage, " "], true);
        } else {
          walk(kids[0]!, lineage, false);
        }
      } else {
        for (let i = 0; i < kids.length; i++) {
          const last = i === kids.length - 1;
          walk(kids[i]!, [...lineage, last ? " " : "│"], true);
        }
      }
    };
    const rootId = store.getRootId();
    const rootEntry = byId.get(rootId);
    if (rootEntry && isVisible(rootEntry)) {
      rows.push({ id: rootId, entry: rootEntry, prefix: "", kind: "tip" });
    }
    const rootKids = visibleChildren(rootId);
    if (rootKids.length === 1) {
      walk(rootKids[0]!, [], false);
    } else {
      for (let i = 0; i < rootKids.length; i++) {
        const last = i === rootKids.length - 1;
        walk(rootKids[i]!, [last ? " " : "│"], true);
      }
    }

    if (rows.length === 0) {
      bus.emit("ui:info", { message: "fork: no past prompts yet" });
      return;
    }

    const items: SelectItem[] = rows.map((r) => {
      const treePrefix = r.prefix ? `${r.prefix} ` : "";
      if (r.kind === "msg") {
        const raw = r.entry.type === "message" && typeof r.entry.message.content === "string"
          ? r.entry.message.content : "";
        const text = stripContextWrappers(raw).slice(0, 70).replace(/\n/g, " ");
        return { value: `msg:${r.id}`, label: `${treePrefix}${text}` };
      }
      const label = r.id === activeLeaf ? "● current" : "leaf";
      return { value: `tip:${r.id}`, label: `${treePrefix}${label}` };
    });
    const picker = app.createSelectList(items, { visibleRows: 15 });
    const activeIdx = items.findIndex((it) => it.value === `tip:${activeLeaf}`);
    picker.setSelectedIndex(activeIdx >= 0 ? activeIdx : items.length - 1);

    const close = (): void => {
      pickerOpen = false;
      app.footerSlot.removeChild(picker.node);
      app.focusInput();
      app.requestRender();
    };

    picker.onSelect(async (item) => {
      close();
      const [kind, id] = item.value.split(":") as ["msg" | "tip", string];
      if (kind === "tip") {
        if (id === store.getActiveLeaf()) return;
        store.setActiveLeaf(id);
        applyBranchMessages(ctx, getStore, capture);
        bus.emit("ui:info", { message: `fork: switched to branch tip ${id.slice(0, 6)}` });
        await rebuildChat();
        refreshFooterStats();
        return;
      }
      const entry = byId.get(id);
      if (!entry || entry.type !== "message") return;
      const targetLeaf = entry.parentId;
      store.setActiveLeaf(targetLeaf);
      applyBranchMessages(ctx, getStore, capture);
      const raw = typeof entry.message.content === "string" ? entry.message.content : "";
      input.setText(stripContextWrappers(raw));
      bus.emit("ui:info", { message: `fork: rewound to ${targetLeaf.slice(0, 6)}` });
      await rebuildChat();
      refreshFooterStats();
    });
    picker.onCancel(close);

    pickerOpen = true;
    app.footerSlot.addChild(picker.node);
    app.setFocus(picker.node);
    app.requestRender();
  };

  const openSessionPicker = async (): Promise<void> => {
    if (pickerOpen) return;

    const hint = new InfoLine(renderer, "↑↓ move · enter: resume · d: delete · esc: cancel");

    const close = (): void => {
      if (activeSessionPicker) app.footerSlot.removeChild(activeSessionPicker.node);
      app.footerSlot.removeChild(hint.node);
      activeSessionPicker = null;
      activeSessionRepopulate = null;
      activeSessionClose = null;
      pickerOpen = false;
      app.focusInput();
      app.requestRender();
    };

    const populate = (keepIndex?: number): boolean => {
      if (activeSessionPicker) app.footerSlot.removeChild(activeSessionPicker.node);
      const currentId = getStore().current().id;
      const list = getStore().listSessions().filter((s) => s.id !== currentId);
      if (list.length === 0) {
        activeSessionPicker = null;
        return false;
      }
      const items: SelectItem[] = list.map((s) => ({
        value: s.id,
        label: formatSessionRow(s, false),
      }));
      const picker = app.createSelectList(items, { visibleRows: 15 });
      if (keepIndex !== undefined) {
        picker.setSelectedIndex(Math.min(keepIndex, items.length - 1));
      }
      picker.onSelect(async (item) => {
        const id = item.value;
        close();
        resumeSession(ctx, getStore, capture, id);
        bus.emit("ui:info", { message: `resumed session ${id}` });
        await rebuildChat();
        refreshFooterStats();
      });
      picker.onCancel(close);
      activeSessionPicker = picker;
      app.footerSlot.addChild(picker.node);
      app.setFocus(picker.node);
      return true;
    };

    app.footerSlot.addChild(hint.node);
    if (!populate()) {
      app.footerSlot.removeChild(hint.node);
      bus.emit("ui:info", { message: "no past sessions in this cwd" });
      return;
    }
    pickerOpen = true;
    activeSessionRepopulate = populate;
    activeSessionClose = close;
    app.requestRender();
  };

  const toggleThinking = (): void => {
    hideThinking = !hideThinking;
    if (processing) {
      // Mid-turn: only show/hide existing nodes. Group-merging respects the
      // new flag for future calls; next idle rebuild reflows everything.
      for (const e of chatEntries) {
        if (e.t === "thinking") e.ctrl.setHidden(hideThinking);
      }
      app.requestRender();
      return;
    }
    void rebuildChat();
  };

  const jobControl = process.platform !== "win32";
  let suspended = false;
  const resumeFromSuspend = (): void => {
    if (!suspended) return;
    suspended = false;
    app.start();
    app.requestRender(true);
  };
  const suspendToShell = (): void => {
    if (suspended) return;
    suspended = true;
    app.stop();
    process.kill(process.pid, "SIGSTOP");
  };
  if (jobControl) process.on("SIGCONT", resumeFromSuspend);

  app.onKey((key: KeyEvent) => {
    if (key.isRelease() || key.isRepeat()) return;
    if (key.matches("escape")) {
      if (processing) {
        bus.emit("agent:cancel-request", {});
        return { consume: true };
      }
      if (shellForegroundBusy) {
        // Real ^C byte; PTY translates it to SIGINT for the foreground process.
        bus.emit("shell:pty-write", { data: "\x03" });
        return { consume: true };
      }
    }
    if (activeSessionPicker && key.matches("d")) {
      const selected = activeSessionPicker.getSelectedItem();
      if (selected) {
        const currentId = getStore().current().id;
        const idx = getStore().listSessions()
          .filter((s) => s.id !== currentId)
          .findIndex((s) => s.id === selected.value);
        try {
          getStore().deleteSession(selected.value);
        } catch (e) {
          bus.emit("ui:error", { message: `delete failed: ${(e as Error).message}` });
          return { consume: true };
        }
        if (!activeSessionRepopulate?.(idx)) activeSessionClose?.();
        app.requestRender();
      }
      return { consume: true };
    }
    if (key.matches("up") && queuedQueries.length > 0 && input.getText().length === 0) {
      const last = queuedQueries.pop()!;
      renderQueueSlot();
      input.setText(last);
      app.requestRender();
      return { consume: true };
    }
    if (key.matches("backspace") && shellMode && input.getText().length === 0) {
      // Editor swallows backspace-on-empty; two-step exit: first clears the
      // private signal, second exits shell mode entirely.
      if (pendingPrivate) setPendingPrivate(false);
      else setShellMode(false);
      return { consume: true };
    }
    if (key.matches("ctrl+c")) {
      input.setText("");
      return { consume: true };
    }
    if (key.matches("ctrl+d") && input.getText().length === 0) {
      ctx.quit();
      return { consume: true };
    }
    if (jobControl && key.matches("ctrl+z")) {
      suspendToShell();
      return { consume: true };
    }
    if (key.matches("ctrl+t")) {
      toggleThinking();
      return { consume: true };
    }
    if (key.matches("shift+tab")) {
      const { level, levels, supported } = bus.emitPipe("config:get-thinking", {
        level: "off", levels: [] as string[], supported: true,
      });
      if (supported && levels.length > 0) {
        const next = levels[(levels.indexOf(level) + 1) % levels.length];
        bus.emit("config:set-thinking", { level: next });
      }
      return { consume: true };
    }
    if (key.matches("ctrl+o")) {
      for (const e of chatEntries) {
        if (e.t === "group") e.group.toggleExpanded();
        else if (e.t === "pair") e.result.toggleExpanded();
      }
      app.requestRender();
      return { consume: true };
    }
    return undefined;
  });

  app.start();

  return {
    stop: () => {
      process.off("SIGCONT", resumeFromSuspend);
      app.stop();
    },
    openTreePicker,
    openSessionPicker,
    rebuildChat,
  };
}
