/**
 * Backend-agnostic LLM facade wired into every ExtensionContext.
 *
 * Delegates to an `llm:invoke` handler registered by the active backend.
 * Backends without an LLM don't define the handler; `available` stays
 * false and calls reject with a clear error.
 */
import type { HandlerRegistry } from "./handler-registry.js";
import type { LlmInterface, LlmMessage, LlmSession } from "../types.js";

export function createLlmFacade(handlers: HandlerRegistry): LlmInterface {
  const invoke = (messages: LlmMessage[], maxTokens?: number): Promise<string> => {
    const result = handlers.call("llm:invoke", messages, { maxTokens });
    if (result === undefined) return Promise.reject(new Error("ctx.llm: no LLM backend available"));
    return result as Promise<string>;
  };
  return {
    get available() { return handlers.list().includes("llm:invoke"); },
    ask: ({ query, system, maxTokens }) => {
      const messages: LlmMessage[] = [];
      if (system) messages.push({ role: "system", content: system });
      messages.push({ role: "user", content: query });
      return invoke(messages, maxTokens);
    },
    session: (opts = {}) => {
      const messages: LlmMessage[] = [];
      if (opts.system) messages.push({ role: "system", content: opts.system });
      const session: LlmSession = {
        async send(message) {
          messages.push({ role: "user", content: message });
          const reply = await invoke(messages, opts.maxTokens);
          messages.push({ role: "assistant", content: reply });
          return reply;
        },
        history: () => messages.slice(),
      };
      return session;
    },
  };
}
