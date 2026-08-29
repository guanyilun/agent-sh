/**
 * Native DeepSeek (api.deepseek.com). V4 ignores reasoning_effort for
 * on/off — disable lives in a separate `thinking` field that defaults
 * to enabled. The hook always attaches; provider registration via env
 * is opt-in alongside any settings.json entry.
 */
import type { AgentContext } from "../host-types.js";
import { resolveApiKey } from "../../cli/auth/keys.js";

const BASE_URL = "https://api.deepseek.com";
const DEFAULT_MODELS = [
  { id: "deepseek-v4-flash", reasoning: true, echoReasoning: true, contextWindow: 1_000_000 },
  { id: "deepseek-v4-pro", reasoning: true, echoReasoning: true, contextWindow: 1_000_000 },
  { id: "deepseek-v4-flash-vision-exp", reasoning: true, echoReasoning: true, contextWindow: 1_000_000, modalities: ["text", "image"] },
];

function buildReasoningParams(level: string, _model?: string): Record<string, unknown> {
  return level === "off"
    ? { thinking: { type: "disabled" } }
    : { thinking: { type: "enabled" }, reasoning_effort: level };
}

export default function activate(ctx: AgentContext): void {
  ctx.agent.providers.configure("deepseek", {
    reasoningParams: buildReasoningParams,
    // Native DeepSeek reports caching as flat hit/miss counts, not the
    // OpenAI-standard prompt_tokens_details.cached_tokens the default reads.
    cacheTokens: (u) => {
      const hit = u.prompt_cache_hit_tokens;
      return typeof hit === "number" ? hit : undefined;
    },
  });
  ctx.agent.providers.register({
    id: "deepseek",
    apiKey: resolveApiKey("deepseek").key ?? undefined,
    baseURL: BASE_URL,
    defaultModel: DEFAULT_MODELS[0].id,
    models: DEFAULT_MODELS,
  });
}
