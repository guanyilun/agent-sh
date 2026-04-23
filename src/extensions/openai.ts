/**
 * Built-in OpenAI-compatible provider — auto-activates when OPENAI_API_KEY
 * is set. OPENAI_BASE_URL redirects to local servers (Ollama, LM Studio,
 * vLLM, llama.cpp) which then get their catalog via /models.
 */
import type { ExtensionContext } from "../types.js";

const DEFAULT_MODELS = [
  "gpt-5",
  "gpt-4.1",
  "gpt-4o",
  "gpt-4o-mini",
  "o3",
  "o3-mini",
];

export default function activate(ctx: ExtensionContext): void {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return;

  const baseURL = process.env.OPENAI_BASE_URL;
  const id = baseURL ? "openai-compatible" : "openai";

  if (!baseURL) {
    ctx.bus.emit("provider:register", {
      id,
      apiKey,
      defaultModel: DEFAULT_MODELS[0],
      models: DEFAULT_MODELS,
    });
    return;
  }

  // Register empty immediately so the provider resolves; refill from /models.
  ctx.bus.emit("provider:register", { id, apiKey, baseURL, models: [] });
  fetchModels(baseURL, apiKey).then((models) => {
    if (models.length === 0) return;
    ctx.bus.emit("provider:register", {
      id,
      apiKey,
      baseURL,
      defaultModel: models[0],
      models,
    });
  }).catch(() => { /* leave empty — user supplies via --model */ });
}

async function fetchModels(baseURL: string, apiKey: string): Promise<string[]> {
  const res = await fetch(`${baseURL.replace(/\/$/, "")}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) return [];
  const data = await res.json() as { data?: { id: string }[] };
  return (data.data ?? []).map((m) => m.id);
}
