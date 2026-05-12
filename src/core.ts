/**
 * Core kernel — the minimum viable agent-sh.
 *
 * Wires up EventBus + HandlerRegistry without any frontend or agent backend.
 * Consumers attach their own I/O (Shell, WebSocket, REST, tests) by
 * subscribing to bus events. Shell-specific tracking lives in the
 * shell-context built-in extension.
 *
 * Agent backends are loaded as extensions and register themselves via
 * the agent:register-backend bus event. The built-in "ash" backend is
 * loaded from src/extensions/agent-backend.ts.
 *
 * Usage:
 *   import { createCore } from "agent-sh";
 *   const core = createCore({ apiKey: "...", model: "gpt-4o" });
 *   core.bus.on("agent:response-chunk", ({ blocks }) => { ... });
 *   core.activateBackend();
 *   const response = await core.query("hello");
 */
import { EventBus, type ContentBlock } from "./event-bus.js";
import type { AgentShellConfig, ExtensionContext, RemoteSessionOptions, RemoteSession } from "./types.js";
import { createLlmFacade } from "./utils/llm-facade.js";
import { setPalette } from "./utils/palette.js";
import * as streamTransform from "./utils/stream-transform.js";
import * as settingsMod from "./settings.js";
import { HandlerRegistry } from "./utils/handler-registry.js";
import crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { DefaultCompositor } from "./utils/compositor.js";
import { CONFIG_DIR } from "./settings.js";

// Re-export types that library consumers need
export { EventBus } from "./event-bus.js";
export type { ShellEvents } from "./event-bus.js";
export type { AgentShellConfig, ExtensionContext, LlmInterface, LlmMessage, LlmSession } from "./types.js";
export { palette, setPalette, resetPalette } from "./utils/palette.js";
export type { ColorPalette } from "./utils/palette.js";
export type { AgentBackend, ToolDefinition } from "./agent/types.js";
export { runSubagent, type SubagentOptions } from "./agent/subagent.js";
export { LlmClient } from "./utils/llm-client.js";
export { HistoryFile, InMemoryHistory, NoopHistory, type HistoryAdapter } from "./agent/history-file.js";
export type { NuclearEntry } from "./agent/nuclear-form.js";

export interface AgentShellCore {
  bus: EventBus;
  /** Handler registry for define/advise/call. */
  handlers: HandlerRegistry;
  /** Unique id for this agent process; used for shell-marker tagging and lineage tracking. */
  instanceId: string;
  /** Activate the agent backend (call after extensions load). */
  activateBackend(override?: string): Promise<void>;
  /** Convenience: emit agent:submit and await the response. */
  query(text: string): Promise<string>;
  /** Convenience: emit agent:cancel-request. */
  cancel(): void;
  /** Convenience: emit agent:append-user-message. */
  appendUserMessage(text: string): void;
  /** Build an ExtensionContext for loading extensions against this core. */
  extensionContext(opts: { quit: () => void }): ExtensionContext;
  /** Tear down the agent and clean up. */
  kill(): void;
}

export function createCore(config: AgentShellConfig): AgentShellCore {
  const bus = new EventBus();
  const handlers = new HandlerRegistry();
  // 3 bytes = 6 hex chars, ~16M values — ample for per-lineage uniqueness and
  // short enough to read/remember. Legacy content may have 16-char iids; any
  // parsers should accept ≥6 hex chars.
  const instanceId = crypto.randomBytes(3).toString("hex");
  bus.setSource(instanceId);
  const settings = settingsMod.getSettings();

  // Expose raw CLI config so the agent backend extension can resolve
  // providers and create the LLM client.
  handlers.define("config:get-shell-config", () => config);

  // Default; shell-context advises with the PTY-tracked cwd when loaded.
  handlers.define("cwd", () => process.cwd());

  // Empty defaults so registerContextProducer can advise regardless of
  // backend. Each backend chooses whether to consume the strings — ash
  // wraps them in <dynamic_context>/<query_context>; bridges may pull
  // query-context:build and splice into the target SDK however they like.
  handlers.define("dynamic-context:build", () => "");
  handlers.define("query-context:build", () => "");

  // ── Multi-backend registry ───────────────────────────────────
  type Backend = { name: string; kill: () => void; start?: () => Promise<void> };
  const backends = new Map<string, Backend>();
  let activeBackendName: string | null = null;

  const activateByName = async (name: string): Promise<boolean> => {
    const backend = backends.get(name);
    if (!backend) {
      bus.emit("ui:error", { message: `Unknown backend: ${name}` });
      return false;
    }

    if (activeBackendName) {
      backends.get(activeBackendName)?.kill();
    }

    await backend.start?.();
    activeBackendName = name;
    return true;
  };

  bus.on("agent:register-backend", (backend) => {
    backends.set(backend.name, backend);
  });

  bus.on("config:switch-backend", ({ name }) => {
    activateByName(name).then((ok) => {
      if (!ok) return;
      settingsMod.updateSettings({ defaultBackend: name });
      // Single ui:info; config:changed (which triggers prompt redraw) follows it.
      bus.emit("ui:info", { message: `Backend: ${name} (saved as default)` });
      bus.emit("config:changed", {});
    });
  });

  bus.on("config:list-backends", () => {
    const names = [...backends.keys()];
    const list = names
      .map((n) => n === activeBackendName ? `${n} (active)` : n)
      .join(", ");
    bus.emit("ui:info", { message: `Backends: ${list}` });
  });

  bus.onPipe("config:get-backends", () => {
    const names = [...backends.keys()];
    return { names, active: activeBackendName };
  });

  // ── Compositor ──────────────────────────────────────────────
  // Generic surface-routing primitive. No defaults here — the active
  // frontend (src/shell/, a web bridge, headless test harness, etc.)
  // sets its own surfaces during activation.
  const compositor = new DefaultCompositor(bus);

  return {
    bus,
    handlers,
    instanceId,

    async activateBackend(override?: string) {
      if (backends.size === 0) return;
      const preferred = override ?? settings.defaultBackend;
      const name = preferred && backends.has(preferred) ? preferred : backends.keys().next().value!;
      await activateByName(name);
    },

    async query(text) {
      return new Promise((resolve, reject) => {
        let response = "";
        let settled = false;

        const onChunk = (e: { blocks: ContentBlock[] }) => {
          for (const b of e.blocks) if (b.type === "text") response += b.text;
        };
        const onDone = () => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(response);
        };
        const onError = (e: { message: string }) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(new Error(e.message));
        };
        const cleanup = () => {
          bus.off("agent:response-chunk", onChunk);
          bus.off("agent:processing-done", onDone);
          bus.off("agent:error", onError);
        };

        bus.on("agent:response-chunk", onChunk);
        bus.on("agent:processing-done", onDone);
        bus.on("agent:error", onError);

        bus.emit("agent:submit", { query: text });
      });
    },

    cancel() {
      bus.emit("agent:cancel-request", {});
    },

    appendUserMessage(text) {
      bus.emit("agent:append-user-message", { text });
    },

    extensionContext(opts) {
      const ctx: ExtensionContext = {
        bus,
        instanceId,
        llm: createLlmFacade(handlers),
        providers: {
          configure: (id, opts) => bus.emit("provider:configure", { id, ...opts }),
        },
        quit: opts.quit,
        setPalette,
        createBlockTransform: (o) => streamTransform.createBlockTransform(bus, o),
        createFencedBlockTransform: (o) =>
          streamTransform.createFencedBlockTransform(bus, o),
        getExtensionSettings: settingsMod.getExtensionSettings,
        getStoragePath: (namespace: string) => {
          const dir = path.join(CONFIG_DIR, namespace);
          fs.mkdirSync(dir, { recursive: true });
          return dir;
        },
        registerCommand: (name, description, handler) =>
          bus.emit("command:register", { name, description, handler }),
        adviseInputMode: (id, advisor) => handlers.advise(`input-mode:${id}:submit`, advisor as Parameters<typeof handlers.advise>[1]),
        adviseCommand: (name, advisor) => {
          const key = name.startsWith("/") ? name : `/${name}`;
          return handlers.advise(`command:${key}`, advisor as Parameters<typeof handlers.advise>[1]);
        },
        registerTool: (tool) => bus.emit("agent:register-tool", { tool, extensionName: "" }),
        unregisterTool: (name) => bus.emit("agent:unregister-tool", { name }),
        adviseTool: (name, advisor) => handlers.advise(`tool:${name}`, advisor as Parameters<typeof handlers.advise>[1]),
        adviseToolSchema: (name, advisor) => handlers.advise(`tool:${name}:schema`, advisor as Parameters<typeof handlers.advise>[1]),
        getTools: () => bus.emitPipe("agent:get-tools", { tools: [] }).tools,
        registerInstruction: (name, text) => bus.emit("agent:register-instruction", { name, text, extensionName: "" }),
        removeInstruction: (name) => bus.emit("agent:remove-instruction", { name }),
        adviseInstruction: (name, advisor) => handlers.advise(`instruction:${name}`, advisor as Parameters<typeof handlers.advise>[1]),
        registerSkill: (name, description, filePath) => bus.emit("agent:register-skill", { name, description, filePath, extensionName: "" }),
        removeSkill: (name) => bus.emit("agent:remove-skill", { name }),
        adviseSkill: (name, advisor) => handlers.advise(`skill:${name}:view`, advisor as Parameters<typeof handlers.advise>[1]),
        registerContextProducer: (_name, producer, opts) => {
          const handlerName = opts?.mode === "per-query"
            ? "query-context:build"
            : "dynamic-context:build";
          return handlers.advise(handlerName, (next) => {
            const base = next() as string;
            const part = producer();
            if (!part) return base;
            const trimmed = part.trim();
            if (!trimmed) return base;
            return base ? `${base}\n\n${trimmed}` : trimmed;
          });
        },
        define: (name, fn) => handlers.define(name, fn),
        advise: (name, wrapper) => handlers.advise(name, wrapper),
        call: (name, ...args) => handlers.call(name, ...args),
        list: () => handlers.list(),
        compositor,
        onDispose: () => {},
        createRemoteSession: (opts: RemoteSessionOptions): RemoteSession => {
          const { surface } = opts;
          const cleanups: (() => void)[] = [];
          let active = true;

          // Redirect all render streams
          cleanups.push(compositor.redirect("agent", surface));
          cleanups.push(compositor.redirect("query", surface));
          cleanups.push(compositor.redirect("status", surface));

          // Suppress the host shell's mute lifecycle and post-turn
          // redraw nudge. on-processing-done is intentionally not advised
          // — its scope cleanup must always run.
          cleanups.push(handlers.advise("shell:on-processing-start", (next) => active ? undefined : next()));
          cleanups.push(handlers.advise("shell:on-processing-redraw", (next) => active ? undefined : next()));

          // Suppress chrome
          if (opts.suppressBorders !== false) {
            cleanups.push(handlers.advise("tui:response-border", (next, ...a) => active ? null : next(...a)));
          }
          if (opts.suppressQueryBox) {
            cleanups.push(handlers.advise("tui:render-user-query", (next, ...a) => active ? [] : next(...a)));
          }
          if (opts.suppressUsage !== false) {
            cleanups.push(handlers.advise("tui:render-usage", (next, ...a) => active ? "" : next(...a)));
          }
          return {
            submit(query: string) { bus.emit("agent:submit", { query }); },
            get surface() { return surface; },
            get active() { return active; },
            close() {
              if (!active) return;
              active = false;
              for (const fn of cleanups.reverse()) fn();
              cleanups.length = 0;
            },
          };
        },
      };
      return ctx;
    },

    kill() {
      if (activeBackendName) {
        backends.get(activeBackendName)?.kill();
      }
    },
  };
}
