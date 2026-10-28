/** Explicit ash engine extension: no provider discovery, implicit tools or UI. */
import type { HostExtension } from "./index.js";
import { AgentLoop } from "../agent/agent-loop.js";
import { attachAgentSurface } from "../agent/surface.js";
import { bindLlmClient } from "../agent/llm-binding.js";
import type { LlmClient } from "../agent/llm-client.js";
import type { Model, ModelEndpoint } from "../agent/host-types.js";
import type { ToolDefinition } from "../agent/types.js";
import type { AgentToolDispatcher } from "../agent/run-contract.js";

export interface AshEngineOptions {
  client: LlmClient;
  model?: Model;
  endpoint?: ModelEndpoint;
  tools?: ToolDefinition[];
  instructions?: string;
  /** Opt into CLI-style global/project prompt and skill discovery. Off by default. */
  ambientContext?: boolean;
  /** Replaces only the execution adapter; tool:execute policy/advice remains outside. */
  executor?: AgentToolDispatcher;
}

/** Share a transport deliberately; a session never reconfigures another session's
 * client unless a caller supplies a mutable shared client and switches models. */
export function ashEngine(options: AshEngineOptions): HostExtension {
  return {
    name: "ash-engine",
    activate(ctx) {
      const surface = attachAgentSurface(ctx);
      bindLlmClient(ctx, options.client);
      const fileReadCache = ctx.call("agent:file-read-cache") ?? new Map();
      ctx.define("agent:file-read-cache", () => fileReadCache);
      const model = options.model ?? { id: options.client.model, provider: "custom" };
      ctx.define("agent:get-models", () => [model]);
      ctx.define("agent:resolve-endpoint", () => options.endpoint);
      for (const tool of options.tools ?? []) surface.registerTool(tool);
      if (options.instructions) surface.registerInstruction("host", options.instructions);
      let loop: AgentLoop | undefined;
      ctx.bus.emit("agent:register-backend", {
        name: "ash",
        start: async () => {
          if (loop) await loop.dispose();
          loop = new AgentLoop({
            bus: ctx.bus,
            llmClient: options.client,
            initialModel: model,
            ambientContext: options.ambientContext ?? false,
            instanceId: ctx.instanceId,
            handlers: { define: ctx.define, advise: ctx.advise, call: ctx.call, list: ctx.list },
          });
          if (options.executor) ctx.define("tool:dispatch", options.executor);
          loop.wire();
        },
        kill: () => { loop?.kill(); loop = undefined; },
      });
    },
  };
}
