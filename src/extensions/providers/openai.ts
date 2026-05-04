/**
 * Cloud OpenAI provider (api.openai.com). Activates on OPENAI_API_KEY
 * unless OPENAI_BASE_URL is also set, in which case openai-compatible
 * handles the request.
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

export default function activate(ctx: ExtensionContext): void {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return;
  if (process.env.OPENAI_BASE_URL) return; // delegated to openai-compatible

  ctx.bus.emit("provider:register", {
    id: "openai",
    apiKey,
    defaultModel: CLOUD_MODELS[0].id,
    models: CLOUD_MODELS,
  });
}
