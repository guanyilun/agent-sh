/**
 * Native DeepSeek (api.deepseek.com). V4 ignores reasoning_effort for
 * on/off — disable lives in a separate `thinking` field that defaults
 * to enabled. The hook always attaches; provider registration via env
 * is opt-in alongside any settings.json entry.
 */
import type { ExtensionContext } from "../../types.js";

const BASE_URL = "https://api.deepseek.com";
const DEFAULT_MODELS = [
  { id: "deepseek-v4-flash", reasoning: true, echoReasoning: true },
  { id: "deepseek-v4-pro", reasoning: true, echoReasoning: true },
];

function buildReasoningParams(level: string, _model?: string): Record<string, unknown> {
  return level === "off"
    ? { thinking: { type: "disabled" } }
    : { thinking: { type: "enabled" }, reasoning_effort: level };
}

export default function activate(ctx: ExtensionContext): void {
  ctx.providers.configure("deepseek", { reasoningParams: buildReasoningParams });

  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) return;
  ctx.bus.emit("provider:register", {
    id: "deepseek",
    apiKey,
    baseURL: BASE_URL,
    defaultModel: DEFAULT_MODELS[0].id,
    models: DEFAULT_MODELS,
  });
}
