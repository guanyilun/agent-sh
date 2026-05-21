/**
 * Ollama provider extension — local daemon or Ollama Cloud.
 *
 * Cloud auth (any of):
 *   agent-sh auth login ollama-cloud   # preferred
 *   OLLAMA_API_KEY=...                 # env fallback
 *
 * Local host:
 *   OLLAMA_HOST (default http://localhost:11434)
 *
 * Catalog comes from /api/tags; per-model context length is fetched
 * from /api/show (model_info["${arch}.context_length"]). Chat goes
 * through the OpenAI-compatible /v1/chat/completions shim.
 *
 * Usage:
 *   agent-sh -e ./examples/extensions/ollama.ts
 *
 *   # Or add to settings.json:
 *   { "extensions": ["./examples/extensions/ollama.ts"] }
 */
import { resolveApiKey } from "agent-sh/auth";
import type { AgentContext } from "agent-sh/types";

const ECHO_REASONING_PATTERNS: RegExp[] = [/deepseek/i];

export default function activate(ctx: AgentContext): void {
  const cloudKey = resolveApiKey("ollama-cloud").key ?? process.env.OLLAMA_API_KEY;
  const host = cloudKey
    ? "https://ollama.com"
    : (process.env.OLLAMA_HOST ?? "http://localhost:11434").replace(/\/$/, "");
  const id = cloudKey ? "ollama-cloud" : "ollama";

  // OpenAI SDK rejects an empty apiKey; the local daemon ignores the value.
  const sdkKey = cloudKey || "no-key";
  const baseURL = `${host}/v1`;
  const headers: Record<string, string> = {};
  if (cloudKey) headers.Authorization = `Bearer ${cloudKey}`;

  ctx.agent.providers.configure(id, {
    reasoningParams: (level) => {
      if (level === "off") return { reasoning_effort: "none" };
      return { reasoning_effort: level === "xhigh" ? "high" : level };
    },
  });

  ctx.agent.providers.register({ id, apiKey: sdkKey, baseURL, models: [] });

  fetchCatalog(host, headers).then((models) => {
    if (models.length === 0) return;
    ctx.agent.providers.register({
      id,
      apiKey: sdkKey,
      baseURL,
      defaultModel: models[0]!.id,
      models,
    });
  }).catch(() => { /* leave empty — user supplies via --model */ });
}

async function fetchCatalog(
  host: string,
  headers: Record<string, string>,
): Promise<{ id: string; contextWindow?: number; echoReasoning: boolean }[]> {
  const tagsRes = await fetch(`${host}/api/tags`, { headers });
  if (!tagsRes.ok) return [];
  const tagsData = await tagsRes.json() as { models?: { name: string }[] };
  const names = (tagsData.models ?? []).map((m) => m.name);
  if (names.length === 0) return [];

  const ctxs = await Promise.all(
    names.map((name) => fetchContextLength(host, headers, name).catch(() => undefined)),
  );
  return names.map((name, i) => ({
    id: name,
    contextWindow: ctxs[i],
    echoReasoning: ECHO_REASONING_PATTERNS.some((re) => re.test(name)),
  }));
}

async function fetchContextLength(
  host: string,
  headers: Record<string, string>,
  name: string,
): Promise<number | undefined> {
  const res = await fetch(`${host}/api/show`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) return undefined;
  const data = await res.json() as { model_info?: Record<string, unknown> };
  const info = data.model_info ?? {};
  const arch = info["general.architecture"] as string | undefined;
  if (arch) {
    const ctx = info[`${arch}.context_length`];
    if (typeof ctx === "number") return ctx;
  }
  for (const [k, v] of Object.entries(info)) {
    if (k.endsWith(".context_length") && typeof v === "number") return v;
  }
  return undefined;
}
