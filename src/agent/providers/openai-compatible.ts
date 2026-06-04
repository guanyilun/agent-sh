/**
 * OpenAI Chat Completions-compatible local/3rd-party server (Ollama, LM
 * Studio, vLLM, llama.cpp, …). Emits the common `reasoning_effort` shape,
 * with `"none"` to disable — the value most local servers honor. A server
 * wanting a different disable token can override via `reasoningShape` or a
 * user extension.
 */
import type { AgentContext } from "../host-types.js";

export default function activate(ctx: AgentContext): void {
  const baseURL = process.env.OPENAI_BASE_URL;
  if (!baseURL) return;

  // Local servers often need no key; SDK still wants a non-empty string.
  const apiKey = process.env.OPENAI_API_KEY || "no-key";
  const id = "openai-compatible";

  ctx.agent.providers.configure(id, {
    reasoningParams: (level) =>
      level === "off"
        ? { reasoning_effort: "none" }
        : { reasoning_effort: level === "xhigh" ? "high" : level },
  });
  ctx.agent.providers.register({ id, apiKey, baseURL, models: [] });
  fetchModels(baseURL, apiKey).then((models) => {
    if (models.length === 0) return;
    ctx.agent.providers.register({
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
