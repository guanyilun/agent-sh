/** Shared legacy LLM handlers for shell and headless hosts. */
import type { HandlerFunctions } from "../utils/handler-registry.js";
import type { LlmClient, ChatCompletionMessageParam } from "./llm-client.js";

export function bindLlmClient(ctx: Pick<HandlerFunctions, "define">, client: LlmClient): void {
  ctx.define("llm:get-client", () => client);
  ctx.define("llm:invoke", (
    messages: ChatCompletionMessageParam[],
    opts?: { maxTokens?: number; model?: string; reasoningEffort?: string },
  ) => {
    const effort = opts?.reasoningEffort;
    const clampedEffort = effort === "xhigh" ? "high" : effort;
    return client.complete({
      messages,
      max_tokens: opts?.maxTokens,
      model: opts?.model,
      ...(clampedEffort && clampedEffort !== "off" ? { reasoning_effort: clampedEffort } : {}),
    });
  });
}
