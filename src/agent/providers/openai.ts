/**
 * Cloud OpenAI (api.openai.com). reasoning_effort vocabulary diverges per
 * family: o-series has no off; gpt-5-codex floors at "low"; plain gpt-5
 * floors at "minimal"; gpt-5.1+ accepts "none" as documented full off.
 * Top tier: only gpt-5.1-codex-max and gpt-5.[4-9]+ accept "xhigh"; others
 * clamp to "high".
 */
import type { AgentContext } from "../host-types.js";
import { resolveApiKey } from "../../cli/auth/keys.js";

const CLOUD_MODELS = [
  { id: "gpt-5", reasoning: true },
  { id: "gpt-4.1", reasoning: false },
  { id: "gpt-4o", reasoning: false },
  { id: "gpt-4o-mini", reasoning: false },
  { id: "o3", reasoning: true },
  { id: "o3-mini", reasoning: true },
];

function offEffortFor(model: string): string | null {
  if (/^o\d/.test(model)) return null;
  if (model.startsWith("gpt-5-codex")) return "low";
  if (/^gpt-5\.[1-9]/.test(model)) return "none";
  if (/^gpt-5(?!\.)/.test(model)) return "minimal";
  return null;
}

function supportsXhigh(model: string): boolean {
  if (model.startsWith("gpt-5.1-codex-max")) return true;
  return /^gpt-5\.[4-9]/.test(model);
}

function buildReasoningParams(level: string, model?: string): Record<string, unknown> {
  if (level !== "off") {
    const effort = level === "xhigh" && !(model && supportsXhigh(model)) ? "high" : level;
    return { reasoning_effort: effort };
  }
  const off = model ? offEffortFor(model) : null;
  return off ? { reasoning_effort: off } : {};
}

export default function activate(ctx: AgentContext): void {
  const apiKey = resolveApiKey("openai").key;
  if (!apiKey) return;
  if (process.env.OPENAI_BASE_URL) return; // openai-compatible handles this

  ctx.agent.providers.configure("openai", { reasoningParams: buildReasoningParams });

  ctx.agent.providers.register({
    id: "openai",
    apiKey,
    defaultModel: CLOUD_MODELS[0].id,
    models: CLOUD_MODELS,
  });
}
