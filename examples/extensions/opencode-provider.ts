/**
 * opencode-provider — OpenCode Zen & Go LLM providers for agent-sh
 *
 * Registers two providers with runtime model discovery:
 *   - opencode     — Zen tier (https://opencode.ai/zen/v1)
 *   - opencode-go  — Go tier  (https://opencode.ai/zen/go/v1)
 *
 * Both are OpenAI-compatible endpoints. OpenCode's backend proxies
 * all models (OpenAI, Anthropic, Google, etc.) through them — no
 * per-model transport routing needed at the agent-sh level.
 *
 * ## Setup
 *   export OPENCODE_***REDACTED***
 *   agent-sh -e ./examples/extensions/opencode-provider.ts
 *
 *   # Or add to settings.json:
 *   { "extensions": ["./examples/extensions/opencode-provider.ts"] }
 *
 *   # Or store via auth:
 *   agent-sh auth login opencode
 *
 * ## Model discovery
 * On startup the extension:
 *   1. Fetches official /models endpoints (authoritative model list)
 *   2. Merges metadata from models.dev (context windows, reasoning flags)
 *   3. Falls back to models.dev membership → conservative defaults
 *
 * Usage:
 *   /model          — tab-completes all discovered models
 *   /provider       — switch between opencode / opencode-go
 */

import type { AgentContext } from "agent-sh/types";
import { resolveApiKey } from "agent-sh/auth";

// ── Constants ──────────────────────────────────────────────────────

const ZEN_BASE_URL = "https://opencode.ai/zen/v1";
const GO_BASE_URL = "https://opencode.ai/zen/go/v1";
const ZEN_MODELS_ENDPOINT = `${ZEN_BASE_URL}/models`;
const GO_MODELS_ENDPOINT = `${GO_BASE_URL}/models`;
const MODELS_DEV_ENDPOINT = "https://models.dev/api.json";

const MODELS_DEV_PROVIDER_IDS = { zen: "opencode", go: "opencode-go" } as const;

/** Conservative defaults when models.dev metadata is unavailable. */
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 16_384;

// ── Fallback model lists (curated; kept in sync with OpenCode docs) ──

const ZEN_FALLBACK_MODELS = [
  "claude-opus-4-7", "claude-opus-4-6", "claude-opus-4-5", "claude-opus-4-1",
  "claude-sonnet-4-6", "claude-sonnet-4-5", "claude-sonnet-4",
  "claude-haiku-4-5", "claude-3-5-haiku",
  "gpt-5.5", "gpt-5.5-pro", "gpt-5.4", "gpt-5.4-pro", "gpt-5.4-mini",
  "gpt-5.4-nano", "gpt-5.3-codex", "gpt-5.3-codex-spark",
  "gpt-5.2", "gpt-5.2-codex", "gpt-5.1", "gpt-5.1-codex",
  "gpt-5.1-codex-max", "gpt-5.1-codex-mini", "gpt-5", "gpt-5-codex",
  "gpt-5-nano",
  "gemini-3.1-pro", "gemini-3-flash",
];

const GO_FALLBACK_MODELS = [
  "gpt-5.3-codex", "gpt-5.2", "gpt-5.2-codex", "gpt-5.1",
  "gpt-5.1-codex", "claude-sonnet-4-6", "claude-sonnet-4-5",
];

// ── Types ───────────────────────────────────────────────────────────

interface ModelsDevLimit {
  context?: number;
  output?: number;
}

interface ModelsDevModelEntry {
  id?: string;
  name?: string;
  reasoning?: boolean;
  limit?: ModelsDevLimit;
  modalities?: { input?: readonly string[] };
}

interface ModelsDevProviderEntry {
  models?: Record<string, ModelsDevModelEntry>;
}

type ModelsDevResponse = Record<string, ModelsDevProviderEntry>;

interface OpenCodeModelListEntry {
  id?: string;
}

interface OpenCodeModelListResponse {
  data?: OpenCodeModelListEntry[];
}

interface ModelDef {
  id: string;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
  input: ("text" | "image")[];
}

// ── Helpers ─────────────────────────────────────────────────────────

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} from ${url}`);
  }
  return res.json() as T;
}

function normalizePosNum(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
}

// ── models.dev ──────────────────────────────────────────────────────

async function fetchModelsDev(): Promise<ModelsDevResponse | undefined> {
  try {
    const payload = await fetchJson<ModelsDevResponse>(MODELS_DEV_ENDPOINT);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
    return payload;
  } catch {
    return undefined;
  }
}

function getModelsDevModel(
  provider: ModelsDevProviderEntry | undefined,
  modelId: string,
): ModelsDevModelEntry | undefined {
  const direct = provider?.models?.[modelId];
  if (direct) return direct;
  if (!provider?.models) return undefined;
  for (const m of Object.values(provider.models)) {
    if (m.id === modelId) return m;
  }
  return undefined;
}

// ── Official /models ────────────────────────────────────────────────

async function fetchOfficialModelIds(url: string): Promise<string[]> {
  try {
    const payload = await fetchJson<OpenCodeModelListResponse>(url);
    if (!Array.isArray(payload.data)) throw new Error("Unexpected format");
    const ids = new Set<string>();
    for (const entry of payload.data) {
      if (typeof entry.id === "string" && entry.id.trim()) {
        ids.add(entry.id.trim());
      }
    }
    return Array.from(ids);
  } catch {
    return [];
  }
}

// ── Merge ───────────────────────────────────────────────────────────

function resolveModel(
  modelId: string,
  metadata: ModelsDevModelEntry | undefined,
): ModelDef {
  const rawInput = metadata?.modalities?.input;
  const input: ("text" | "image")[] = Array.isArray(rawInput)
    ? rawInput.filter((v): v is "text" | "image" => v === "text" || v === "image")
    : ["text"];
  return {
    id: modelId,
    reasoning: metadata?.reasoning ?? false,
    contextWindow: normalizePosNum(metadata?.limit?.context) ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: normalizePosNum(metadata?.limit?.output) ?? DEFAULT_MAX_TOKENS,
    input,
  };
}

// ── Reasoning params (OpenAI-compatible) ────────────────────────────

function buildReasoningParams(level: string): Record<string, unknown> {
  if (level === "off") return {};
  return { reasoning_effort: level === "xhigh" ? "high" : level };
}

// ── Activation ──────────────────────────────────────────────────────

export default function activate(ctx: AgentContext): void {
  const apiKey =
    process.env.OPENCODE_API_KEY ??
    resolveApiKey("opencode").key ??
    undefined;

  // ── Phase 1: register both providers synchronously with fallback models ──

  ctx.agent.providers.configure("opencode", { reasoningParams: buildReasoningParams });
  ctx.agent.providers.register({
    id: "opencode",
    apiKey,
    baseURL: ZEN_BASE_URL,
    defaultModel: ZEN_FALLBACK_MODELS[0],
    models: ZEN_FALLBACK_MODELS,
    supportsReasoningEffort: true,
  });

  ctx.agent.providers.configure("opencode-go", { reasoningParams: buildReasoningParams });
  ctx.agent.providers.register({
    id: "opencode-go",
    apiKey,
    baseURL: GO_BASE_URL,
    defaultModel: GO_FALLBACK_MODELS[0],
    models: GO_FALLBACK_MODELS,
    supportsReasoningEffort: true,
  });

  if (!apiKey) return;

  // ── Phase 2: fetch live catalogs and re-register with enriched metadata ──

  fetchModelsDev()
    .then(async (modelsDev) => {
      const zenProvider = modelsDev?.[MODELS_DEV_PROVIDER_IDS.zen];
      const goProvider = modelsDev?.[MODELS_DEV_PROVIDER_IDS.go];

      // Fetch Zen + Go model IDs in parallel
      const [zenIds, goIds] = await Promise.all([
        fetchOfficialModelIds(ZEN_MODELS_ENDPOINT),
        fetchOfficialModelIds(GO_MODELS_ENDPOINT),
      ]);

      // Resolve with metadata, falling back to fallback lists if /models was empty
      const resolveModels = (
        ids: string[],
        provider: ModelsDevProviderEntry | undefined,
        fallback: string[],
      ): ModelDef[] => {
        const source = ids.length > 0 ? ids : fallback;
        return source.map((id) => resolveModel(id, getModelsDevModel(provider, id)));
      };

      const zenModels = resolveModels(zenIds, zenProvider, ZEN_FALLBACK_MODELS);
      const goModels = resolveModels(goIds, goProvider, GO_FALLBACK_MODELS);

      // Re-register both with full catalogs (still uses the same apiKey)
      ctx.agent.providers.register({
        id: "opencode",
        apiKey,
        baseURL: ZEN_BASE_URL,
        defaultModel: zenModels[0]?.id ?? ZEN_FALLBACK_MODELS[0],
        models: zenModels,
        supportsReasoningEffort: true,
      });

      ctx.agent.providers.register({
        id: "opencode-go",
        apiKey,
        baseURL: GO_BASE_URL,
        defaultModel: goModels[0]?.id ?? GO_FALLBACK_MODELS[0],
        models: goModels,
        supportsReasoningEffort: true,
      });
    })
    .catch(() => {
      // Keep fallback models from Phase 1
    });
}
