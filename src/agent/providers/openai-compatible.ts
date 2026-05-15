/**
 * OpenAI Chat Completions-compatible local/3rd-party server (Ollama, LM
 * Studio, vLLM, llama.cpp, …). No reasoning hook — the right shape depends
 * on which model the server is serving; user extensions can add one.
 */
import type { ExtensionContext } from "../../shell/host-types.js";

export default function activate(ctx: ExtensionContext): void {
  const baseURL = process.env.OPENAI_BASE_URL;
  if (!baseURL) return;

  // Local servers often need no key; SDK still wants a non-empty string.
  const apiKey = process.env.OPENAI_API_KEY || "no-key";
  const id = "openai-compatible";

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
  const headers: Record<string, string> = {};
  if (apiKey && apiKey !== "no-key") headers.Authorization = `Bearer ${apiKey}`;
  const res = await fetch(`${baseURL.replace(/\/$/, "")}/models`, { headers });
  if (!res.ok) return [];
  const data = await res.json() as { data?: { id: string }[] };
  return (data.data ?? []).map((m) => m.id);
}
