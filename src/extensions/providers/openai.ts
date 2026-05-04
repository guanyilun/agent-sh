/**
 * Cloud OpenAI provider (api.openai.com). Activates on OPENAI_API_KEY
 * unless OPENAI_BASE_URL is also set, in which case openai-compatible
 * handles the request.
 *
 * The reasoning_effort vocabulary diverges per model family:
 *   - o-series (o1/o3/o3-mini): only low|medium|high; no off-switch
 *   - gpt-5-codex:              low is the floor (minimal not supported)
 *   - gpt-5 (original):         minimal is the floor
 *   - gpt-5.1 / 5.4 / 5.5+:     none is documented full off
 */
import type { ExtensionContext } from "../../types.js";

const CLOUD_MODELS = [
  { id: "gpt-5", reasoning: true },
  { id: "gpt-4.1", reasoning: false },
  { id: "gpt-4o", reasoning: false },
  { id: "gpt-4o-mini", reasoning: false },
  { id: "o3", reasoning: true },
  { id: "o3-mini", reasoning: true },
];

function offEffortFor(model: string): string | null {
  if (/^o\d/.test(model)) return null;                // o-series: no off
  if (model.startsWith("gpt-5-codex")) return "low";  // codex: minimal not accepted
  if (/^gpt-5\.[1-9]/.test(model)) return "none";     // 5.1+: documented off
  if (/^gpt-5(?!\.)/.test(model)) return "minimal";   // plain gpt-5: minimal floor
  return null;
}

function buildReasoningParams(level: string, model?: string): Record<string, unknown> {
  if (level !== "off") return { reasoning_effort: level };
  const off = model ? offEffortFor(model) : null;
  return off ? { reasoning_effort: off } : {};
}

export default function activate(ctx: ExtensionContext): void {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return;
  if (process.env.OPENAI_BASE_URL) return; // delegated to openai-compatible

  ctx.providers.configure("openai", { reasoningParams: buildReasoningParams });

  ctx.bus.emit("provider:register", {
    id: "openai",
    apiKey,
    defaultModel: CLOUD_MODELS[0].id,
    models: CLOUD_MODELS,
  });
}
