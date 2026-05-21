/**
 * Core kernel — the minimum viable agent-sh.
 *
 * Wires up EventBus + HandlerRegistry. Nothing else. Core knows nothing
 * about agents, backends, identity, tools, LLMs, or anything else
 * substantive — those are all extension concerns.
 *
 * The agent-backend built-in extension (src/extensions/agent-backend/)
 * owns the concept of "backend": registration, switching, identity.
 * Specific backends (ash, claude-code-bridge, ...) register through it.
 *
 * Usage:
 *   import { createCore } from "agent-sh";
 *   const core = createCore({ ... });
 *   core.bus.on("agent:response-chunk", ({ blocks }) => { ... });
 *   // Load built-ins (which include agent-backend), then user
 *   // extensions, then host calls handlers.call("agent-backend:activate").
 */
import { EventBus } from "./event-bus.js";
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
  /** Backward-compat convenience — delegates to the agent-backend extension. */
  activateBackend(override?: string): Promise<void>;
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
  handlers.define("config:get-app-config", () => config);

  // Default; shell-context advises with the PTY-tracked cwd when loaded.
  handlers.define("cwd", () => process.cwd());

  // Empty defaults so registerContextProducer can advise regardless of
  // backend. Each backend chooses whether to consume the strings — ash
  // wraps them in <dynamic_context>/<query_context>; bridges may pull
  // query-context:build and splice into the target SDK however they like.
  handlers.define("dynamic-context:build", () => "");
  handlers.define("query-context:build", () => "");

  return {
    bus,
    handlers,
    instanceId,

    async activateBackend(override?: string) {
      await handlers.call("agent-backend:activate", override);
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
      // agent-backend handles backend teardown if it's loaded.
      try { handlers.call("agent-backend:kill"); } catch { /* not loaded */ }
    },
  };
}
