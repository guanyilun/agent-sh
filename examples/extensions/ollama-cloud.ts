/**
 * Ollama Cloud — hosted Ollama models (https://ollama.com).
 *
 * Auth:  agent-sh auth login ollama-cloud
 * Usage: agent-sh -e ./examples/extensions/ollama-cloud.ts
 */
import { resolveApiKey } from "agent-sh/auth";
import type { AgentContext } from "agent-sh/types";

const HOST = "https://ollama.com";
const BASE_URL = `${HOST}/v1`;
const ID = "ollama-cloud";

function buildReasoningParams(level: string, _model?: string): Record<string, unknown> {
  return { reasoning_effort: level === "off" ? "none" : level };
}

async function fetchModels(apiKey: string) {
  const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` };
  const tagsRes = await fetch(`${HOST}/api/tags`, { headers });
  if (!tagsRes.ok) return [];
  const tagsData = await tagsRes.json() as { models?: { name: string }[] };
  const names = (tagsData.models ?? []).map((m) => m.name);
  if (!names.length) return [];

  const ctxs = await Promise.all(
    names.map((name) =>
      fetch(`${HOST}/api/show`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      })
        .then((r) => r.ok ? r.json() as Promise<{ model_info?: Record<string, unknown> }> : null)
        .then((d) => {
          if (!d?.model_info) return undefined;
          const info = d.model_info;
          const arch = info["general.architecture"] as string | undefined;
          if (arch) {
            const ctx = info[`${arch}.context_length`];
            if (typeof ctx === "number") return ctx;
          }
          for (const [k, v] of Object.entries(info)) {
            if (k.endsWith(".context_length") && typeof v === "number") return v;
          }
          return undefined;
        })
        .catch(() => undefined),
    ),
  );

  return names.map((name, i) => ({
    id: name,
    contextWindow: ctxs[i],
    echoReasoning: /deepseek/i.test(name),
  }));
}

export default function activate(ctx: AgentContext): void {
  const { key } = resolveApiKey(ID);
  const apiKey = key ?? process.env.OLLAMA_API_KEY;
  if (!apiKey) return;

  ctx.agent.providers.configure(ID, { reasoningParams: buildReasoningParams });

  // Register placeholder while catalog loads
  ctx.bus.emit("provider:register", { id: ID, apiKey, baseURL: BASE_URL, models: [] });

  fetchModels(apiKey).then((models) => {
    if (!models.length) return;
    ctx.bus.emit("provider:register", {
      id: ID,
      apiKey,
      baseURL: BASE_URL,
      defaultModel: models[0]!.id,
      models,
    });
  }).catch(() => { /* keep placeholder */ });
}
