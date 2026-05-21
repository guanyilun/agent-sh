/**
 * Augments core's BusEvents with the events ash owns — providers,
 * modes, ash-specific switching, and LLM wire-level observability.
 * Other backends don't have providers or modes, so these don't belong
 * in the generic agent-backend protocol.
 */
import type { ProviderRegistration } from "./host-types.js";

declare module "../core/event-bus.js" {
  interface BusEvents {
    // ── Provider registry (ash-only) ──────────────────────────────
    /** Pipe accumulator — pulled by agentBackend to compute the
     *  merged provider catalog. Contributors are installed by
     *  `ctx.agent.providers.register`. */
    "agent:providers": { providers: ProviderRegistration[] };
    /** Notification: a provider contribution was added/removed.
     *  agentBackend re-derives modes in response. */
    "agent:providers:changed": Record<string, never>;
    /** Reasoning hook configuration — independent of registration. */
    "provider:configure": {
      id: string;
      reasoningParams?: (level: string, model?: string) => Record<string, unknown>;
    };

    // ── Ash mode notifications ────────────────────────────────────
    /** Notification: the canonical mode catalog changed (settings/
     *  providers shifted). AgentLoop pulls fresh via the
     *  `agent:get-modes` handler. */
    "agent:modes-changed": Record<string, never>;
    /** Ash-only provider switch — user picked a provider via /provider. */
    "config:switch-provider": { provider: string };

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
