/** Kimi Coding Plan — Moonshot's K2 coding subscription on an OpenAI-compatible endpoint. */
import type { AgentContext } from "../host-types.js";
import { resolveApiKey } from "../../cli/auth/keys.js";

const BASE_URL = "https://api.kimi.com/coding/v1";
const ID = "kimi-coding-plan";

const DEFAULT_MODELS = [
  {
    id: "kimi-for-coding",
    reasoning: true,
    contextWindow: 262_144,
    maxTokens: 32_768,
    modalities: ["text", "image"] as ("text" | "image")[],
  },
];

export default function activate(ctx: AgentContext): void {
  const { key } = resolveApiKey(ID);
  ctx.agent.providers.register({
    id: ID,
    apiKey: key ?? process.env.KIMI_API_KEY ?? process.env.MOONSHOT_API_KEY,
    baseURL: BASE_URL,
    defaultModel: DEFAULT_MODELS[0].id,
    models: DEFAULT_MODELS,
  });
}
