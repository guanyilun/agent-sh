/**
 * Pi bridge — runs pi's full coding agent in-process as agent-sh's backend.
 *
 * Uses pi's own AgentSession with its full configuration: model registry,
 * provider settings, extensions, session management, and tool system.
 * Agent-sh provides the shell frontend and TUI rendering.
 *
 * The bridge is a pure protocol translator between pi's event stream and
 * agent-sh's bus events. Pi brings its own tools for command execution,
 * file ops, etc. PTY-access tools (`terminal_read`, `terminal_keys`,
 * `user_shell`) are intentionally NOT bundled here — if you want pi to
 * observe or mutate the user's live terminal, load a companion extension
 * that registers those tools in pi's ToolDefinition format.
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

// ── Extension entry point ─────────────────────────────────────────
export default function activate(ctx: ExtensionContext): void {
  const { bus, call } = ctx;
  const cwd = process.cwd();

  // ── Boot pi session (async — register backend synchronously first) ──
  let session: any = null;
  let runtime: any = null;
  let modelRegistry: any = null;
  let booting = true;

  const PI_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

  const boot = async () => {
    try {
      // Pi loads its own config: ~/.pi/agent/settings.json, models, extensions
      const services = await createAgentSessionServices({ cwd });
      modelRegistry = services.modelRegistry;
      const sessionManager = SessionManager.inMemory(cwd);

      // createRuntime factory — returns { session, services, ... } as expected
      // by createAgentSessionRuntime
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

      // Subscribe to pi events → agent-sh bus
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

          case "tool_execution_start":
            bus.emit("agent:tool-started", {
              title: (event as any).toolName,
              toolCallId: (event as any).toolCallId,
              kind: (event as any).toolName === "bash" ? "execute" : "read",
            });
            break;

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

          case "tool_execution_end":
            bus.emit("agent:tool-completed", {
              toolCallId: (event as any).toolCallId,
              exitCode: (event as any).isError ? 1 : 0,
              kind: (event as any).toolName === "bash" ? "execute" : "read",
            });
            break;

          case "agent_end":
            bus.emitTransform("agent:response-done", {
              response: fullResponseText,
            });
            bus.emit("agent:processing-done", {});
            break;
        }
      });

      const model = session.model;
      bus.emit("agent:info", {
        name: "pi",
        version: "0.66",
        model: model ? `${model.provider}/${model.id}` : undefined,
      });

      booting = false;
    } catch (err) {
      booting = false;
      bus.emit("ui:error", {
        message: `pi-bridge: failed to initialize — ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  };

  // ── Bus listeners (wired on start, unwired on kill) ────────────
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
      bus.emit("ui:info", { message: `Thinking: ${level}` });
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

  // ── Register as backend ───────────────────────────────────────
  bus.emit("agent:register-backend", {
    name: "pi",
    start: async () => {
      await boot();
      wireListeners();
    },
    kill: () => {
      unwireListeners();
      runtime?.dispose();
      session = null;
      runtime = null;
      modelRegistry = null;
      booting = true;
    },
  });
}
