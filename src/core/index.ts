/**
 * Core kernel — the minimum viable agent-sh.
 *
 * Wires up EventBus + HandlerRegistry without any frontend or agent backend.
 * Consumers attach their own I/O (Shell, WebSocket, REST, tests) by
 * subscribing to bus events. Shell-specific tracking lives in the
 * shell-context built-in extension.
 *
 * Agent backends register themselves via the agent:register-backend bus
 * event. The built-in "ash" backend lives in src/agent/ and is activated
 * by hosts via activateAgent().
 *
 * Usage:
 *   import { createCore } from "agent-sh";
 *   const core = createCore({ apiKey: "...", model: "gpt-4o" });
 *   core.bus.on("agent:response-chunk", ({ blocks }) => { ... });
 *   core.activateBackend();
 *   const response = await core.query("hello");
 */
import { EventBus, type ContentBlock } from "./event-bus.js";
import type { AppConfig, ExtensionContext } from "../shell/host-types.js";
import * as settingsMod from "./settings.js";
import { HandlerRegistry } from "../utils/handler-registry.js";
import crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR } from "./settings.js";

export { EventBus } from "./event-bus.js";
export type { ShellEvents, ContentBlock } from "./event-bus.js";
export type { CoreContext, CoreConfig } from "./types.js";
export type { AgentContext, AgentConfig, AgentSurface, AgentConfigSurface, AgentMode, LlmInterface, LlmMessage, LlmSession } from "../agent/host-types.js";
export type { ShellContext, ShellConfig, ShellSurface, ShellConfigSurface, ExtensionContext, RemoteSession, RemoteSessionOptions, RenderSurface, InputModeConfig, TerminalSession, BlockTransformOptions, FencedBlockTransformOptions, AppConfig } from "../shell/host-types.js";
export { palette, setPalette, resetPalette } from "../utils/palette.js";
export type { ColorPalette } from "../utils/palette.js";
export type { AgentBackend, ToolDefinition } from "../agent/types.js";
export { runSubagent, type SubagentOptions } from "../agent/subagent.js";
export { LlmClient } from "../utils/llm-client.js";
export { HistoryFile, InMemoryHistory, NoopHistory, type HistoryAdapter } from "../agent/history-file.js";
export type { NuclearEntry } from "../agent/nuclear-form.js";
export { compileSearchRegex, matchEntry, formatNuclearLine } from "../agent/nuclear-form.js";

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

export function createCore(config: AppConfig): AgentShellCore {
  const bus = new EventBus();
  const handlers = new HandlerRegistry();
  // 3 bytes = 6 hex chars, ~16M values — ample for per-lineage uniqueness and
  // short enough to read/remember. Legacy content may have 16-char iids; any
  // parsers should accept ≥6 hex chars.
  const instanceId = crypto.randomBytes(3).toString("hex");
  bus.setSource(instanceId);
  const settings = settingsMod.getSettings();

  handlers.define("config:get-app-config", () => config);

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
      const ctx = {
        bus,
        instanceId,
        quit: opts.quit,
        define: (name: string, fn: (...args: any[]) => any) => handlers.define(name, fn),
        advise: (name: string, wrapper: (next: (...args: any[]) => any, ...args: any[]) => any) => handlers.advise(name, wrapper),
        call: (name: string, ...args: any[]) => handlers.call(name, ...args),
        list: () => handlers.list(),
        onDispose: () => {},
        getExtensionSettings: settingsMod.getExtensionSettings,
        getStoragePath: (namespace: string) => {
          const dir = path.join(CONFIG_DIR, namespace);
          fs.mkdirSync(dir, { recursive: true });
          return dir;
        },
        registerCommand: (name: string, description: string, handler: (args: string) => Promise<void> | void) =>
          bus.emit("command:register", { name, description, handler }),
        adviseCommand: (name: string, advisor: (next: (args: string) => Promise<void> | void, args: string) => Promise<void> | void) => {
          const key = name.startsWith("/") ? name : `/${name}`;
          return handlers.advise(`command:${key}`, advisor as Parameters<typeof handlers.advise>[1]);
        },
      } as unknown as ExtensionContext;
      return ctx;
    },

    kill() {
      if (activeBackendName) {
        backends.get(activeBackendName)?.kill();
      }
    },
  };
}
