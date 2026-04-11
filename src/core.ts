/**
 * Core kernel — the minimum viable agent-sh.
 *
 * Wires up EventBus + ContextManager + AgentBackend without any frontend.
 * Consumers attach their own I/O (Shell, WebSocket, REST, tests) by
 * subscribing to bus events.
 *
 * Agent backends are bus-driven — they self-wire to bus events in their
 * constructor. Core creates the backend and holds a reference for lifecycle.
 *
 * Two backend modes:
 *   - Internal agent (apiKey provided): AgentLoop + LlmClient (in-process)
 *   - ACP subprocess (agentCommand provided): AcpClient (existing behavior)
 *
 * Usage:
 *   import { createCore } from "agent-sh";
 *   const core = createCore({ agentCommand: "pi-acp" });
 *   core.bus.on("agent:response-chunk", ({ text }) => ws.send(text));
 *   await core.start();
 *   const response = await core.query("hello");
 */
import { EventBus, type ContentBlock } from "./event-bus.js";
import { ContextManager } from "./context-manager.js";
import { createAgentBackend } from "./agent/index.js";
import { LlmClient } from "./utils/llm-client.js";
import type { AgentShellConfig, ExtensionContext } from "./types.js";
import { setPalette } from "./utils/palette.js";
import * as streamTransform from "./utils/stream-transform.js";
import * as settingsMod from "./settings.js";
import { HandlerRegistry } from "./utils/handler-registry.js";

// Re-export types that library consumers need
export { EventBus } from "./event-bus.js";
export type { ShellEvents } from "./event-bus.js";
export type { AgentShellConfig, ExtensionContext } from "./types.js";
export { palette, setPalette, resetPalette } from "./utils/palette.js";
export type { ColorPalette } from "./utils/palette.js";
export type { AgentBackend } from "./agent/types.js";
export { LlmClient } from "./utils/llm-client.js";

export interface AgentShellCore {
  bus: EventBus;
  contextManager: ContextManager;
  /** LLM client for fast-path features (null in ACP mode). */
  llmClient: LlmClient | null;
  /** Connect to the agent subprocess (ACP mode). No-op for internal agent. */
  start(): Promise<void>;
  /** Convenience: emit agent:submit and await the response. */
  query(text: string, opts?: { mode?: string }): Promise<string>;
  /** Convenience: emit agent:cancel-request. */
  cancel(): void;
  /** Build an ExtensionContext for loading extensions against this core. */
  extensionContext(opts: { quit: () => void }): ExtensionContext;
  /** Tear down the agent and clean up. */
  kill(): void;
}

export function createCore(config: AgentShellConfig): AgentShellCore {
  const bus = new EventBus();
  const handlers = new HandlerRegistry();
  const contextManager = new ContextManager(bus);

  // Shared LLM client — used by agent loop AND fast-path features
  const llmClient =
    config.apiKey
      ? new LlmClient({
          apiKey: config.apiKey,
          baseURL: config.baseURL,
          model: config.model ?? "gpt-4o",
        })
      : null;

  // Create agent backend via factory — both backends self-wire to bus events
  const backend = createAgentBackend(config, bus, contextManager, llmClient ?? undefined);

  return {
    bus,
    contextManager,
    llmClient,

    async start() {
      await backend.start?.();
    },

    async query(text, opts) {
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

        bus.emit("agent:submit", {
          query: text,
          modeInstruction: opts?.mode,
        });
      });
    },

    cancel() {
      bus.emit("agent:cancel-request", {});
    },

    extensionContext(opts) {
      return {
        bus,
        contextManager,
        llmClient,
        quit: opts.quit,
        setPalette,
        createBlockTransform: (o) => streamTransform.createBlockTransform(bus, o),
        createFencedBlockTransform: (o) =>
          streamTransform.createFencedBlockTransform(bus, o),
        getExtensionSettings: settingsMod.getExtensionSettings,
        define: (name, fn) => handlers.define(name, fn),
        advise: (name, wrapper) => handlers.advise(name, wrapper),
        call: (name, ...args) => handlers.call(name, ...args),
      };
    },

    kill() {
      backend.kill();
    },
  };
}
