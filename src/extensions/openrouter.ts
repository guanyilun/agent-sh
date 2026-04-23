/**
 * Built-in OpenRouter provider — auto-activates when OPENROUTER_API_KEY is set.
 * Registers curated defaults synchronously so the first query works, then
 * fetches the full catalog to populate /model autocomplete.
 */
import type { ExtensionContext } from "../types.js";

const BASE_URL = "https://openrouter.ai/api/v1";

// First entry is the cold-start default — kept cheap so trial users don't
// get a surprise bill. Persisted /model selection overrides this.
const DEFAULT_MODELS = [
  "deepseek/deepseek-v3.2",
  "anthropic/claude-sonnet-4.6",
];

interface OpenRouterModel {
  id: string;
  supported_parameters?: string[];
  context_length?: number;
}

export default function activate(ctx: ExtensionContext): void {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return;

  ctx.bus.emit("provider:register", {
    id: "openrouter",
    apiKey,
    baseURL: BASE_URL,
    defaultModel: DEFAULT_MODELS[0],
    models: DEFAULT_MODELS,
  });

  fetchModels(apiKey).then((models) => {
    if (models.length === 0) return;
    ctx.bus.emit("provider:register", {
      id: "openrouter",
      apiKey,
      baseURL: BASE_URL,
      defaultModel: DEFAULT_MODELS[0],
      supportsReasoningEffort: true,
      models: models.map((m) => ({
        id: m.id,
        reasoning: m.supported_parameters?.includes("reasoning") ?? false,
        contextWindow: m.context_length,
      })),
    });
  }).catch(() => { /* keep curated defaults */ });
}

async function fetchModels(apiKey: string): Promise<OpenRouterModel[]> {
  const res = await fetch(`${BASE_URL}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) return [];
  const data = await res.json() as { data?: OpenRouterModel[] };
  return data.data ?? [];
}
