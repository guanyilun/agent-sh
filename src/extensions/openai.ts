/**
 * Built-in OpenAI-compatible provider. Two activation paths:
 *   - OPENAI_API_KEY only       → cloud OpenAI, ships a curated catalog.
 *   - OPENAI_BASE_URL (any key) → local/3rd-party server (Ollama, LM Studio,
 *                                  vLLM, llama.cpp); the catalog is fetched
 *                                  from the server's /models endpoint.
 */
import type { ExtensionContext } from "../types.js";

const OPENAI_CLOUD_MODELS = [
  { id: "gpt-5", reasoning: true },
  { id: "gpt-4.1", reasoning: false },
  { id: "gpt-4o", reasoning: false },
  { id: "gpt-4o-mini", reasoning: false },
  { id: "o3", reasoning: true },
  { id: "o3-mini", reasoning: true },
];

export default function activate(ctx: ExtensionContext): void {
  const apiKey = process.env.OPENAI_API_KEY ?? "";
  const baseURL = process.env.OPENAI_BASE_URL;

  if (!baseURL) {
    if (!apiKey) return;
    ctx.bus.emit("provider:register", {
      id: "openai",
      apiKey,
      defaultModel: OPENAI_CLOUD_MODELS[0].id,
      models: OPENAI_CLOUD_MODELS,
    });
    return;
  }

  const id = "openai-compatible";
  // Local servers (Ollama, llama.cpp) often need no key; the SDK still
  // requires a non-empty string for construction.
  const sdkKey = apiKey || "no-key";
  ctx.bus.emit("provider:register", { id, apiKey: sdkKey, baseURL, models: [] });
  fetchModels(baseURL, apiKey).then((models) => {
    if (models.length === 0) return;
    ctx.bus.emit("provider:register", {
      id,
      apiKey: sdkKey,
      baseURL,
      defaultModel: models[0],
      models,
    });
  }).catch(() => { /* leave empty — user supplies via --model */ });
}

async function fetchModels(baseURL: string, apiKey: string): Promise<string[]> {
  const headers: Record<string, string> = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const res = await fetch(`${baseURL.replace(/\/$/, "")}/models`, { headers });
  if (!res.ok) return [];
  const data = await res.json() as { data?: { id: string }[] };
  return (data.data ?? []).map((m) => m.id);
}
