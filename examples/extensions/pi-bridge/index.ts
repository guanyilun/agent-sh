/**
 * Pi bridge — runs pi's full coding agent in-process as agent-sh's backend.
 * Pure protocol translator between pi's event stream and agent-sh's bus.
 *
 * Setup:
 *   npm install @mariozechner/pi-agent-core @mariozechner/pi-ai @mariozechner/pi-coding-agent
 *
 * Usage:
 *   agent-sh -e examples/extensions/pi-bridge
 */
import type { AgentEvent } from "@mariozechner/pi-agent-core";
import {
  createAgentSessionServices,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  SessionManager,
} from "@mariozechner/pi-coding-agent";
import type { ExtensionContext } from "agent-sh/types";
import { existsSync, readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { diffLines } from "diff";

const TOOL_KINDS: Record<string, string> = {
  bash: "execute",
  read: "read",
  ls: "read",
  find: "read",
  grep: "search",
  edit: "execute",
  write: "execute",
};
const kindForTool = (name: string): string => TOOL_KINDS[name] ?? "execute";

type DiffLineRecord = { type: "context" | "added" | "removed"; oldNo: number | null; newNo: number | null; text: string };
type DiffHunkRecord = { lines: DiffLineRecord[] };
type DiffResultRecord = { hunks: DiffHunkRecord[]; added: number; removed: number; isIdentical: boolean; isNewFile: boolean };

function buildDiffFromTexts(oldText: string, newText: string, isNewFile: boolean): DiffResultRecord | null {
  if (oldText === newText) return null;
  const changes = diffLines(oldText, newText);
  const allLines: DiffLineRecord[] = [];
  let oldNo = 0;
  let newNo = 0;
  let added = 0;
  let removed = 0;
  for (const change of changes) {
    const lines = change.value.replace(/\n$/, "").split("\n");
    for (const text of lines) {
      if (change.added) {
        newNo++;
        allLines.push({ type: "added", oldNo: null, newNo, text });
        added++;
      } else if (change.removed) {
        oldNo++;
        allLines.push({ type: "removed", oldNo, newNo: null, text });
        removed++;
      } else {
        oldNo++;
        newNo++;
        allLines.push({ type: "context", oldNo, newNo, text });
      }
    }
  }
  if (allLines.length === 0) return null;
  return {
    hunks: [{ lines: allLines }],
    added,
    removed,
    isIdentical: false,
    isNewFile,
  };
}

// Pi's edit returns a custom diff string: prefix(+/-/space) + lineNum + " " + text, "..." between hunks.
function parsePiDiff(raw: unknown): DiffResultRecord | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  const hunks: DiffHunkRecord[] = [];
  let current: DiffLineRecord[] = [];
  let added = 0;
  let removed = 0;
  let hasOriginal = false;
  let delta = 0;

  const flush = () => {
    if (current.length > 0) hunks.push({ lines: current });
    current = [];
  };

  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    const prefix = line[0];
    const rest = line.slice(1);
    if (prefix === " " && rest.trim() === "...") { flush(); continue; }
    const m = rest.match(/^\s*(\d+)\s(.*)$/);
    if (!m) continue;
    const num = parseInt(m[1]!, 10);
    const text = m[2]!;
    if (prefix === "+") {
      current.push({ type: "added", oldNo: null, newNo: num, text });
      added++;
      delta++;
    } else if (prefix === "-") {
      current.push({ type: "removed", oldNo: num, newNo: null, text });
      removed++;
      delta--;
      hasOriginal = true;
    } else if (prefix === " ") {
      current.push({ type: "context", oldNo: num, newNo: num + delta, text });
      hasOriginal = true;
    }
  }
  flush();

  if (hunks.length === 0) return null;
  return { hunks, added, removed, isIdentical: added + removed === 0, isNewFile: !hasOriginal };
}

export default function activate(ctx: ExtensionContext): void {
  const { bus, call } = ctx;
  const cwd = process.cwd();

  let session: any = null;
  let runtime: any = null;
  let modelRegistry: any = null;
  let booting = true;

  const PI_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

  // Pi's tool_execution_end omits `args` — cache from start so the end handler can use the path.
  const pendingArgs = new Map<string, any>();
  // Snapshot disk content before pi writes; diffed against args.content at end.
  const pendingWriteSnapshot = new Map<string, { oldContent: string; isNewFile: boolean }>();

  const boot = async () => {
    try {
      const services = await createAgentSessionServices({ cwd });
      modelRegistry = services.modelRegistry;
      const sessionManager = SessionManager.inMemory(cwd);

      const createRuntime = async (opts: any) => {
        const result = await createAgentSessionFromServices({
          services,
          sessionManager: opts.sessionManager ?? sessionManager,
        });
        return { ...result, services };
      };

      runtime = await createAgentSessionRuntime(createRuntime, {
        cwd,
        sessionManager,
      });
      session = runtime.session;

      let fullResponseText = "";

      session.subscribe((event: AgentEvent) => {
        switch (event.type) {
          case "agent_start":
            fullResponseText = "";
            break;

          case "message_update": {
            const ame = (event as any).assistantMessageEvent;
            if (ame.type === "text_delta") {
              bus.emitTransform("agent:response-chunk", {
                blocks: [{ type: "text" as const, text: ame.delta }],
              });
              fullResponseText += ame.delta;
            } else if (ame.type === "thinking_delta") {
              bus.emit("agent:thinking-chunk", { text: ame.delta });
            }
            break;
          }

          case "message_end": {
            // Synthesize agent:tool-batch so tui-renderer groups parallel tool calls under one header.
            const msg = (event as any).message;
            if (msg?.role === "assistant" && Array.isArray(msg.content)) {
              const groupMap = new Map<string, Array<{ name: string }>>();
              for (const block of msg.content) {
                if (block?.type === "toolCall" && typeof block.name === "string") {
                  const kind = kindForTool(block.name);
                  if (!groupMap.has(kind)) groupMap.set(kind, []);
                  groupMap.get(kind)!.push({ name: block.name });
                }
              }
              if (groupMap.size > 0) {
                const groups = Array.from(groupMap.entries()).map(([kind, tools]) => ({ kind, tools }));
                bus.emit("agent:tool-batch", { groups });
              }
            }
            break;
          }

          case "tool_execution_start": {
            const ev = event as any;
            if (ev.toolCallId) pendingArgs.set(ev.toolCallId, ev.args);
            if (ev.toolName === "write" && ev.toolCallId && typeof ev.args?.path === "string") {
              const abs = resolvePath(cwd, ev.args.path);
              let oldContent = "";
              let isNewFile = true;
              if (existsSync(abs)) {
                try { oldContent = readFileSync(abs, "utf8"); isNewFile = false; } catch {}
              }
              pendingWriteSnapshot.set(ev.toolCallId, { oldContent, isNewFile });
            }
            bus.emit("agent:tool-started", {
              title: ev.toolName,
              toolCallId: ev.toolCallId,
              kind: kindForTool(ev.toolName),
              rawInput: ev.args,
            });
            break;
          }

          case "tool_execution_update": {
            const pr = (event as any).partialResult as
              | { content?: Array<{ type: string; text?: string }> }
              | undefined;
            if (pr?.content) {
              for (const c of pr.content) {
                if (c.type === "text" && c.text) {
                  bus.emit("agent:tool-output-chunk", { chunk: c.text });
                }
              }
            }
            break;
          }

          case "tool_execution_end": {
            const ev = event as any;
            const args = ev.toolCallId ? pendingArgs.get(ev.toolCallId) : undefined;
            if (ev.toolCallId) pendingArgs.delete(ev.toolCallId);
            let resultDisplay: { body?: { kind: "diff"; diff: unknown; filePath: string } } | undefined;
            if (ev.toolName === "edit" && typeof args?.path === "string") {
              const rawDiff = ev.result?.details?.diff;
              const parsed = parsePiDiff(rawDiff);
              if (parsed) {
                resultDisplay = {
                  body: { kind: "diff", diff: parsed, filePath: args.path },
                };
              }
            } else if (ev.toolName === "write" && typeof args?.path === "string" && !ev.isError) {
              const snap = ev.toolCallId ? pendingWriteSnapshot.get(ev.toolCallId) : undefined;
              if (ev.toolCallId) pendingWriteSnapshot.delete(ev.toolCallId);
              if (snap) {
                const newContent = typeof args.content === "string" ? args.content : "";
                const built = buildDiffFromTexts(snap.oldContent, newContent, snap.isNewFile);
                if (built) {
                  resultDisplay = {
                    body: { kind: "diff", diff: built, filePath: args.path },
                  };
                }
              }
            }
            bus.emit("agent:tool-completed", {
              toolCallId: ev.toolCallId,
              exitCode: ev.isError ? 1 : 0,
              kind: kindForTool(ev.toolName),
              rawOutput: ev.result,
              resultDisplay,
            });
            break;
          }

          case "agent_end":
            bus.emitTransform("agent:response-done", {
              response: fullResponseText,
            });
            bus.emit("agent:processing-done", {});
            break;
        }
      });

      booting = false;
      const m = session.model;
      bus.emit("agent:info", {
        name: "pi",
        version: "0.66",
        model: m ? `${m.provider}/${m.id}` : undefined,
      });
    } catch (err) {
      booting = false;
      bus.emit("ui:error", {
        message: `pi-bridge: failed to initialize — ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  };

  type ListenerEntry =
    | { kind: "on"; event: string; fn: Function }
    | { kind: "pipe"; event: string; fn: Function };
  const listeners: ListenerEntry[] = [];

  const wireListeners = () => {
    const onSubmit = async ({ query }: any) => {
      if (!session) {
        bus.emit("agent:error", {
          message: booting ? "pi is still starting up..." : "pi session not initialized",
        });
        bus.emit("agent:processing-done", {});
        return;
      }

      bus.emit("agent:query", { query });
      bus.emit("agent:processing-start", {});

      // Inline producers raw — outputs already self-tag (<shell_events>...).
      const ctxText = String(call("query-context:build") ?? "").trim();
      const final = ctxText ? `${ctxText}\n\n${query}` : query;

      try {
        await session.prompt(final);
      } catch (err) {
        bus.emit("agent:error", {
          message: err instanceof Error ? err.message : String(err),
        });
        bus.emit("agent:processing-done", {});
      }
    };

    const onCancel = async () => { await session?.abort(); };
    const onReset = async () => {
      await runtime?.newSession();
      session = runtime?.session;
    };

    const onListModels = () => {
      if (!session || !modelRegistry) return { models: [], active: null };
      const all = modelRegistry.getAvailable() as Array<{ id: string; provider: string }>;
      const cur = session.model;
      return {
        models: all.map((m) => ({ model: m.id, provider: m.provider })),
        active: cur ? { model: cur.id, provider: cur.provider } : null,
      };
    };

    // Slash command emits `model@provider` for disambiguation; pi looks up by (provider, id).
    const onSwitchModel = async ({ model: target }: { model: string }) => {
      if (!session || !modelRegistry) return;
      const atIdx = target.lastIndexOf("@");
      const modelId = atIdx > 0 ? target.slice(0, atIdx) : target;
      const providerHint = atIdx > 0 ? target.slice(atIdx + 1) : undefined;

      const candidates = (modelRegistry.getAvailable() as Array<{ id: string; provider: string }>)
        .filter((m) => m.id === modelId && (!providerHint || m.provider === providerHint));

      if (candidates.length === 0) {
        bus.emit("ui:error", { message: `Unknown model: ${target}` });
        return;
      }
      if (candidates.length > 1) {
        const opts = candidates.map((m) => `${m.id}@${m.provider}`).join(", ");
        bus.emit("ui:error", { message: `Ambiguous model "${modelId}". Use one of: ${opts}` });
        return;
      }
      const picked = candidates[0]!;
      const full = modelRegistry.find(picked.provider, picked.id);
      if (!full) {
        bus.emit("ui:error", { message: `Model not found: ${target}` });
        return;
      }
      try {
        await session.setModel(full);
        bus.emit("agent:info", {
          name: "pi",
          version: "0.66",
          model: `${picked.provider}/${picked.id}`,
        });
        bus.emit("ui:info", { message: `Model: ${picked.provider}: ${picked.id}` });
        bus.emit("config:changed", {});
      } catch (err) {
        bus.emit("ui:error", {
          message: `Failed to switch model: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    };

    const onGetThinking = () => {
      const level = session?.thinkingLevel ?? "off";
      return { level, levels: [...PI_THINKING_LEVELS], supported: true };
    };

    const onSetThinking = ({ level }: { level: string }) => {
      if (!session) return;
      if (!PI_THINKING_LEVELS.includes(level as any)) {
        bus.emit("ui:error", {
          message: `Unknown thinking level: ${level}. Use: ${PI_THINKING_LEVELS.join(", ")}`,
        });
        return;
      }
      session.setThinkingLevel(level);
      bus.emit("config:changed", {});
    };

    bus.on("agent:submit", onSubmit);
    bus.on("agent:cancel-request", onCancel);
    bus.on("agent:reset-session", onReset);
    bus.on("config:switch-model", onSwitchModel as any);
    bus.on("config:set-thinking", onSetThinking as any);
    bus.onPipe("config:get-models", onListModels as any);
    bus.onPipe("config:get-thinking", onGetThinking as any);
    listeners.push(
      { kind: "on", event: "agent:submit", fn: onSubmit },
      { kind: "on", event: "agent:cancel-request", fn: onCancel },
      { kind: "on", event: "agent:reset-session", fn: onReset },
      { kind: "on", event: "config:switch-model", fn: onSwitchModel },
      { kind: "on", event: "config:set-thinking", fn: onSetThinking },
      { kind: "pipe", event: "config:get-models", fn: onListModels },
      { kind: "pipe", event: "config:get-thinking", fn: onGetThinking },
    );
  };

  const unwireListeners = () => {
    for (const { kind, event, fn } of listeners) {
      if (kind === "pipe") bus.offPipe(event as any, fn as any);
      else bus.off(event as any, fn as any);
    }
    listeners.length = 0;
  };

  bus.emit("agent:register-backend", {
    name: "pi",
    start: async () => {
      await boot();
      wireListeners();
      bus.emit("command:register", {
        name: "/compact",
        description: "Compact pi's session context",
        handler: async () => {
          if (!session) return;
          try {
            await session.compact();
            bus.emit("ui:info", { message: "(compacted)" });
          } catch (err) {
            bus.emit("ui:info", {
              message: `(${err instanceof Error ? err.message : String(err)})`,
            });
          }
        },
      });
      bus.emit("command:register", {
        name: "/context",
        description: "Show pi's context budget usage",
        handler: () => {
          if (!session) return;
          const usage = session.getContextUsage() as { tokens: number; contextWindow: number } | undefined;
          if (!usage) {
            bus.emit("ui:info", { message: "Context: not available yet" });
            return;
          }
          const pct = usage.contextWindow > 0
            ? Math.round((usage.tokens / usage.contextWindow) * 100)
            : 0;
          bus.emit("ui:info", {
            message: `Active context: ~${usage.tokens.toLocaleString()} tokens / ${usage.contextWindow.toLocaleString()} budget (${pct}%)`,
          });
        },
      });
    },
    kill: () => {
      bus.emit("command:unregister", { name: "/compact" });
      bus.emit("command:unregister", { name: "/context" });
      unwireListeners();
      runtime?.dispose();
      session = null;
      runtime = null;
      modelRegistry = null;
      booting = true;
    },
  });
}
