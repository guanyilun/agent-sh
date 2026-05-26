/**
 * Registers `ollama` (local, no auth) and `ollama-cloud` (login via
 * `agent-sh auth login ollama-cloud` or OLLAMA_API_KEY). Local host
 * overridable via OLLAMA_HOST.
 */
import type { AgentContext } from "agent-sh/types";

const ECHO_REASONING_PATTERNS: RegExp[] = [/deepseek/i];

function reasoningParams(level: string): Record<string, unknown> {
  if (level === "off") return { reasoning_effort: "none" };
  return { reasoning_effort: level === "xhigh" ? "high" : level };
}

export default function activate(ctx: AgentContext): void {
  const cloudKey =
    (ctx.call("provider:resolve-api-key", "ollama-cloud") as { key: string | null }).key ??
    process.env.OLLAMA_API_KEY;
  const cloudHost = "https://ollama.com";
  const cloudBaseURL = `${cloudHost}/v1`;
  ctx.agent.providers.configure("ollama-cloud", { reasoningParams });
  ctx.agent.providers.register({
    id: "ollama-cloud",
    apiKey: cloudKey ?? undefined,
    baseURL: cloudBaseURL,
    models: [],
  });
  if (cloudKey) {
    const headers = { Authorization: `Bearer ${cloudKey}` };
    fetchCatalog(cloudHost, headers).then((models) => {
      if (models.length === 0) return;
      ctx.agent.providers.register({
        id: "ollama-cloud",
        apiKey: cloudKey,
        baseURL: cloudBaseURL,
        defaultModel: models[0]!.id,
        models,
      });
    }).catch(() => {});
  }

  const localHost = (process.env.OLLAMA_HOST ?? "http://localhost:11434").replace(/\/$/, "");
  const localBaseURL = `${localHost}/v1`;
  ctx.agent.providers.configure("ollama", { reasoningParams });
  // OpenAI SDK rejects an empty apiKey; the local daemon ignores it.
  ctx.agent.providers.register({
    id: "ollama",
    apiKey: "no-key",
    baseURL: localBaseURL,
    models: [],
    noAuth: true,
  });
  fetchCatalog(localHost, {}).then((models) => {
    if (models.length === 0) return;
    ctx.agent.providers.register({
      id: "ollama",
      apiKey: "no-key",
      baseURL: localBaseURL,
      defaultModel: models[0]!.id,
      models,
      noAuth: true,
    });
  }).catch(() => {});
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
