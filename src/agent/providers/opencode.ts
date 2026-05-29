/**
 * OpenCode Zen & Go providers — runtime model discovery via /models +
 * models.dev metadata enrichment.
 *
 * Registers two providers:
 *   - opencode     — Zen tier  (https://opencode.ai/zen/v1)
 *   - opencode-go  — Go tier   (https://opencode.ai/zen/go/v1)
 */
import type { AgentContext } from "../host-types.js";
import { resolveApiKey } from "../../cli/auth/keys.js";

const ZEN_BASE_URL = "https://opencode.ai/zen/v1";
const GO_BASE_URL = "https://opencode.ai/zen/go/v1";
const MODELS_DEV_ENDPOINT = "https://models.dev/api.json";

const DEFAULT_CTX = 128_000;
const DEFAULT_MAX_TOKENS = 16_384;

const ZEN_FALLBACK = ["claude-sonnet-4-6"];
const GO_FALLBACK = ["gpt-5.2"];

// ── Types ────────────────────────────────────────────────────────

interface ModelsDevLimit { context?: number; output?: number; }
interface ModelsDevEntry {
  id?: string; name?: string; reasoning?: boolean;
  limit?: ModelsDevLimit; modalities?: { input?: readonly string[] };
}
type ModelsDevResponse = Record<string, { models?: Record<string, ModelsDevEntry> }>;

interface ModelDef {
  id: string; reasoning: boolean; contextWindow: number;
  maxTokens: number; modalities: ("text" | "image")[];
}

// ── Helpers ──────────────────────────────────────────────────────

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as T;
}

function findEntry(provider: ModelsDevResponse[string] | undefined, id: string): ModelsDevEntry | undefined {
  const direct = provider?.models?.[id];
  if (direct) return direct;
  if (!provider?.models) return undefined;
  return Object.values(provider.models).find((m) => m.id === id);
}

function resolveModel(id: string, meta: ModelsDevEntry | undefined): ModelDef {
  const raw = meta?.modalities?.input;
  const modalities: ("text" | "image")[] = Array.isArray(raw)
    ? raw.filter((v): v is "text" | "image" => v === "text" || v === "image")
    : ["text"];
  return {
    id,
    reasoning: meta?.reasoning ?? false,
    contextWindow: (typeof meta?.limit?.context === "number" && meta.limit.context > 0)
      ? meta.limit.context : DEFAULT_CTX,
    maxTokens: (typeof meta?.limit?.output === "number" && meta.limit.output > 0)
      ? meta.limit.output : DEFAULT_MAX_TOKENS,
    modalities,
  };
}

function reasoningParams(level: string): Record<string, unknown> {
  if (level === "off") return { reasoning_effort: "none" };
  return { reasoning_effort: level === "xhigh" ? "high" : level };
}

// ── Activation ───────────────────────────────────────────────────

export default function activate(ctx: AgentContext): void {
  const apiKey =
    process.env.OPENCODE_API_KEY ??
    resolveApiKey("opencode").key ?? undefined;

  ctx.agent.providers.configure("opencode", { reasoningParams });
  ctx.agent.providers.register({
    id: "opencode", apiKey, baseURL: ZEN_BASE_URL,
    defaultModel: ZEN_FALLBACK[0], models: ZEN_FALLBACK,
    supportsReasoningEffort: true,
  });

  ctx.agent.providers.configure("opencode-go", { reasoningParams });
  ctx.agent.providers.register({
    id: "opencode-go", apiKey, baseURL: GO_BASE_URL,
    defaultModel: GO_FALLBACK[0], models: GO_FALLBACK,
    supportsReasoningEffort: true,
  });

  if (!apiKey) return;

  fetchModelsDev()
    .then(async (md) => {
      const zenIds = await fetchModelIds(ZEN_BASE_URL);
      const goIds = await fetchModelIds(GO_BASE_URL);

      const resolve = (ids: string[], prov: ModelsDevResponse[string] | undefined, fb: string[]) =>
        (ids.length > 0 ? ids : fb).map((id) => resolveModel(id, findEntry(prov, id)));

      const zen = resolve(zenIds, md?.opencode, ZEN_FALLBACK);
      const go = resolve(goIds, md?.["opencode-go"], GO_FALLBACK);

      ctx.agent.providers.register({
        id: "opencode", apiKey, baseURL: ZEN_BASE_URL,
        defaultModel: zen[0]?.id ?? ZEN_FALLBACK[0], models: zen,
        supportsReasoningEffort: true,
      });
      ctx.agent.providers.register({
        id: "opencode-go", apiKey, baseURL: GO_BASE_URL,
        defaultModel: go[0]?.id ?? GO_FALLBACK[0], models: go,
        supportsReasoningEffort: true,
      });
    })
    .catch(() => {});
}

async function fetchModelsDev(): Promise<ModelsDevResponse | undefined> {
  try {
    const payload = await fetchJson<ModelsDevResponse>(MODELS_DEV_ENDPOINT);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
    return payload;
  } catch { return undefined; }
}

async function fetchModelIds(baseURL: string): Promise<string[]> {
  try {
    const res = await fetch(`${baseURL}/models`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return [];
    const payload = await res.json() as { data?: { id: string }[] };
    if (!Array.isArray(payload.data)) return [];
    return [...new Set(payload.data.map((e) => e.id).filter(Boolean))];
  } catch { return []; }
}
