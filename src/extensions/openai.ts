/**
 * Built-in OpenAI-compatible provider extension.
 *
 * Auto-activates if `OPENAI_API_KEY` is set. Honors `OPENAI_BASE_URL` so
 * local servers (Ollama, LM Studio, vLLM, llama.cpp) and self-hosted
 * gateways work without any settings.json edits:
 *
 *   export OPENAI_API_KEY=dummy
 *   export OPENAI_BASE_URL=http://localhost:11434/v1
 *
 * Against openai.com: registers with a curated model shortlist. Against
 * a custom endpoint: fetches `/models` to populate the catalog.
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

  // Custom endpoint — fetch the catalog from /models so the user doesn't
  // need to pass --model. Register immediately with an empty list so the
  // provider resolves; re-register once the fetch returns.
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
