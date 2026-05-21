/** Ash-owned bus events. */
import type { ProviderRegistration } from "./host-types.js";

declare module "../core/event-bus.js" {
  interface BusEvents {
    "agent:providers": { providers: ProviderRegistration[] };
    "agent:providers:changed": Record<string, never>;
    "provider:configure": {
      id: string;
      reasoningParams?: (level: string, model?: string) => Record<string, unknown>;
    };

    "agent:modes-changed": Record<string, never>;
    "config:switch-provider": { provider: string };

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
