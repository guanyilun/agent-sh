/**
 * Augments core's BusEvents with the events ash owns — provider
 * registry, ash-specific mode/config events, and LLM wire-level
 * observability. Other backends don't have providers or modes, so
 * these don't belong in the generic agent-backend protocol.
 */
import type { AgentMode } from "./host-types.js";

declare module "../core/event-bus.js" {
  interface BusEvents {
    // ── Provider registry (ash-only concept) ──────────────────────
    "provider:register": {
      id: string;
      apiKey?: string;
      baseURL?: string;
      /** Optional — providers for custom endpoints may not know the catalog
       *  at registration time. Falls back to models[0] when absent. */
      defaultModel?: string;
      models?: (string | { id: string; reasoning?: boolean; contextWindow?: number; maxTokens?: number; echoReasoning?: boolean })[];
      /** Provider supports the reasoning_effort parameter. Default: true. */
      supportsReasoningEffort?: boolean;
    };
    "provider:configure": {
      id: string;
      reasoningParams?: (level: string, model?: string) => Record<string, unknown>;
    };

    // ── Ash mode/provider switching ───────────────────────────────
    "config:switch-provider": { provider: string };
    "config:get-initial-modes": { modes: AgentMode[]; initialModeIndex: number };
    "config:set-modes": { modes: AgentMode[]; activeIndex?: number };
    "config:add-modes": { modes: AgentMode[] };

    // ── LLM wire-level observability (ash only emits) ─────────────
    "llm:request": {
      messages: unknown[];
      tools?: unknown;
      model?: string;
      max_tokens?: number;
      reasoning_effort?: string;
    };
    "llm:chunk": { chunk: unknown };
  }
}

export {};
