/**
 * Core kernel — EventBus + HandlerRegistry + backend registry. Knows
 * nothing about LLMs, tools, or specific backends; backends (ash,
 * claude-code-bridge, ...) register through `agent:register-backend`
 * and core dispatches to whichever is configured as default.
 */
import { EventBus, type BackendRegistration } from "./event-bus.js";
// Side-effect imports so downstream tsc sees module-augmented BusEvents.
import "../shell/events.js";
import "../agent/events.js";
import "../extensions/slash-commands/events.js";
import type { AppConfig, ExtensionContext } from "../shell/host-types.js";
import * as settingsMod from "./settings.js";
import { HandlerRegistry } from "../utils/handler-registry.js";
import crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR } from "./settings.js";

export { EventBus } from "./event-bus.js";
export type { BusEvents, ContentBlock, BackendRegistration } from "./event-bus.js";
export type { CoreContext, CoreConfig } from "./types.js";
export type { AgentContext, AgentConfig, AgentSurface, AgentConfigSurface, AgentMode, LlmInterface, LlmMessage, LlmSession } from "../agent/host-types.js";
export type { ShellContext, ShellConfig, ShellSurface, ShellConfigSurface, ExtensionContext, RemoteSession, RemoteSessionOptions, RenderSurface, InputModeConfig, TerminalSession, BlockTransformOptions, FencedBlockTransformOptions, AppConfig } from "../shell/host-types.js";
export { palette, setPalette, resetPalette } from "../utils/palette.js";
export type { ColorPalette } from "../utils/palette.js";
export type { AgentBackend, ToolDefinition, ImageContent } from "../agent/types.js";
export { runSubagent, type SubagentOptions } from "../agent/subagent.js";
export { LlmClient } from "../agent/llm-client.js";
export { HistoryFile, InMemoryHistory, NoopHistory, type HistoryAdapter } from "../agent/history-file.js";
export type { NuclearEntry } from "../agent/nuclear-form.js";
export { compileSearchRegex, matchEntry, formatNuclearLine } from "../agent/nuclear-form.js";

export interface AgentShellCore {
  bus: EventBus;
  handlers: HandlerRegistry;
  /** Unique id for this agent process; used for shell-marker tagging and lineage tracking. */
  instanceId: string;
  /** Activates a registered backend by name (or persisted default / first registered). */
  activateBackend(override?: string): Promise<void>;
  extensionContext(opts: { quit: () => void }): ExtensionContext;
  kill(): void;
}

export function createCore(config: AppConfig): AgentShellCore {
  const bus = new EventBus();
  const handlers = new HandlerRegistry();
  // 3 bytes = 6 hex chars; legacy content may have 16-char iids so parsers
  // should accept ≥6 hex chars.
  const instanceId = crypto.randomBytes(3).toString("hex");
  bus.setSource(instanceId);
  handlers.define("config:get-app-config", () => config);
  handlers.define("cwd", () => process.cwd());

  // Empty defaults so registerContextProducer can advise regardless of
  // backend. Each backend chooses how to consume the strings.
  handlers.define("dynamic-context:build", () => "");
  handlers.define("query-context:build", () => "");

  const backends = new Map<string, BackendRegistration>();
  let activeBackendName: string | null = null;

  bus.on("agent:register-backend", (backend) => {
    backends.set(backend.name, backend);
  });

  bus.onPipe("config:get-backends", () => ({
    names: [...backends.keys()],
    active: activeBackendName,
  }));

  const activateByName = async (name: string): Promise<boolean> => {
    const backend = backends.get(name);
    if (!backend) {
      bus.emit("ui:error", { message: `Unknown backend: ${name}` });
      return false;
    }
    if (activeBackendName && activeBackendName !== name) {
      backends.get(activeBackendName)?.kill();
    }
    activeBackendName = name;
    await backend.start?.();
    return true;
  };

  bus.on("config:switch-backend", ({ name }) => {
    activateByName(name).then((ok) => {
      if (!ok) return;
      settingsMod.updateSettings({ defaultBackend: name });
      bus.emit("ui:info", { message: `Backend: ${name} (saved as default)` });
      bus.emit("config:changed", {});
    });
  });

  bus.on("config:list-backends", () => {
    const list = [...backends.keys()]
      .map((n) => n === activeBackendName ? `${n} (active)` : n)
      .join(", ");
    bus.emit("ui:info", { message: `Backends: ${list || "(none registered)"}` });
  });

  return {
    bus,
    handlers,
    instanceId,

    async activateBackend(override?: string) {
      if (backends.size === 0) {
        bus.emit("ui:info", { message: "No agent backend registered." });
        return;
      }
      const preferred = override ?? settingsMod.getSettings().defaultBackend;
      const name = preferred && backends.has(preferred)
        ? preferred
        : backends.keys().next().value!;
      await activateByName(name);
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
        activeBackendName = null;
      }
    },
  };
}
