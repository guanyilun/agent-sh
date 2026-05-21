/**
 * Built-in OpenRouter provider — auto-activates when OPENROUTER_API_KEY is set.
 * Registers curated defaults synchronously so the first query works, then
 * fetches the full catalog to populate /model autocomplete.
 */
import type { AgentContext } from "../host-types.js";
import { getSettings } from "../../core/settings.js";
import { resolveApiKey } from "../../cli/auth/keys.js";

const BASE_URL = "https://openrouter.ai/api/v1";

const DEFAULT_MODELS = ["deepseek/deepseek-v4-flash"];

// Built-in defaults for models requiring reasoning_content echoed back
// (server 400s without it). Extend or override in settings.json:
//   providers.openrouter.echoReasoningPatterns = ["deepseek", "..."]
//   providers.openrouter.models[*].echoReasoning = true | false
const BUILTIN_ECHO_REASONING_PATTERNS: RegExp[] = [/deepseek/i];

// `effort: "none"` is the documented disable; honored by OpenAI/Grok, ignored
// by Anthropic/Gemini/DeepSeek-via-OpenRouter (use native deepseek for a hard off).
function buildReasoningParams(level: string, _model?: string): Record<string, unknown> {
  return level === "off"
    ? { reasoning: { effort: "none" } }
    : { reasoning: { effort: level } };
}

interface OpenRouterModel {
  id: string;
  supported_parameters?: string[];
  context_length?: number;
}

export default function activate(ctx: AgentContext): void {
  const apiKey = resolveApiKey("openrouter").key;
  if (!apiKey) return;

  ctx.agent.providers.configure("openrouter", { reasoningParams: buildReasoningParams });

  ctx.agent.providers.register({
    id: "openrouter",
    apiKey,
    baseURL: BASE_URL,
    defaultModel: DEFAULT_MODELS[0],
    models: DEFAULT_MODELS,
  });

  fetchModels(apiKey).then((models) => {
    if (models.length === 0) return;
    const userOverrides = readUserOverrides();
    const patterns = readEchoPatterns();
    // Replaces the curated default contribution for "openrouter".
    ctx.agent.providers.register({
      id: "openrouter",
      apiKey,
      baseURL: BASE_URL,
      defaultModel: DEFAULT_MODELS[0],
      supportsReasoningEffort: true,
      models: models.map((m) => ({
        id: m.id,
        reasoning: m.supported_parameters?.includes("reasoning") ?? false,
        contextWindow: m.context_length,
        echoReasoning: userOverrides.get(m.id) ?? patterns.some((re) => re.test(m.id)),
      })),
    });
  }).catch(() => { /* keep curated defaults */ });
}

function readEchoPatterns(): RegExp[] {
  const userPatterns = getSettings().providers?.openrouter?.echoReasoningPatterns ?? [];
  const compiled: RegExp[] = [];
  for (const src of userPatterns) {
    try { compiled.push(new RegExp(src, "i")); }
    catch { /* skip invalid pattern */ }
  }
  return [...BUILTIN_ECHO_REASONING_PATTERNS, ...compiled];
}

function readUserOverrides(): Map<string, boolean> {
  const out = new Map<string, boolean>();
  const models = getSettings().providers?.openrouter?.models;
  if (!Array.isArray(models)) return out;
  for (const m of models) {
    if (typeof m === "object" && m && m.echoReasoning !== undefined) {
      out.set(m.id, m.echoReasoning);
    }
  }
  return out;
}

async function fetchModels(apiKey: string): Promise<OpenRouterModel[]> {
  const res = await fetch(`${BASE_URL}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) return [];
  const data = await res.json() as { data?: OpenRouterModel[] };
  return data.data ?? [];
}
