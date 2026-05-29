/**
 * Z.AI Coding Plan — Zhipu AI's subscription GLM models for coding.
 */
import type { AgentContext } from "../host-types.js";
import { resolveApiKey } from "../../cli/auth/keys.js";

const BASE_URL = "https://api.z.ai/api/coding/paas/v4";
const ID = "zai-coding-plan";

const DEFAULT_MODELS = [
  { id: "glm-5.1",     reasoning: true, contextWindow: 200_000 },
  { id: "glm-5-turbo", reasoning: true, contextWindow: 200_000 },
  { id: "glm-4.7",     reasoning: true, contextWindow: 204_800 },
  { id: "glm-4.5-air", reasoning: true, contextWindow: 131_072 },
];

function buildReasoningParams(level: string, _model?: string): Record<string, unknown> {
  if (level === "off") return { thinking: { type: "disabled" } };
  const effort = level === "xhigh" ? "high" : level;
  return { thinking: { type: "enabled" }, reasoning_effort: effort };
}

export default function activate(ctx: AgentContext): void {
  const { key } = resolveApiKey(ID);
  ctx.agent.providers.configure(ID, { reasoningParams: buildReasoningParams });
  ctx.agent.providers.register({
    id: ID,
    apiKey: key ?? process.env.ZAI_API_KEY ?? process.env.ZHIPU_API_KEY,
    baseURL: BASE_URL,
    defaultModel: DEFAULT_MODELS[0].id,
    models: DEFAULT_MODELS,
  });
}
