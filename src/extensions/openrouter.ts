/**
 * Built-in OpenRouter provider extension.
 *
 * Auto-activates if `OPENROUTER_API_KEY` is set in the environment. Registers
 * the provider immediately with a curated default list so the first query
 * works, then fetches the full catalog in the background so `/model` shows
 * everything available on the user's OpenRouter account.
 *
 * Silent no-op when the env var is absent — the user opts in by exporting
 * the key rather than by editing settings.json.
 */
import type { ExtensionContext } from "../types.js";

const BASE_URL = "https://openrouter.ai/api/v1";

/** Curated picks used immediately while the full catalog loads.
 *  First entry is the cold-start default — chosen to be cheap so users
 *  can try agent-sh without a surprise bill. Change via /model (persists)
 *  or set providers.openrouter.defaultModel in settings.json. */
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

  // Async catalog fetch — update registration once it returns so /model
  // autocomplete carries the full list. Failures fall back to curated.
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
