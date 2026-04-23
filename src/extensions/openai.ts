/**
 * Built-in OpenAI provider extension.
 *
 * Auto-activates if `OPENAI_API_KEY` is set. Registers the OpenAI provider
 * with a small curated model list. Silent no-op when the env var is absent.
 */
import type { ExtensionContext } from "../types.js";

const DEFAULT_MODELS = [
  "gpt-5",
  "gpt-4.1",
  "gpt-4o",
  "gpt-4o-mini",
  "o3",
  "o3-mini",
];

export default function activate(ctx: ExtensionContext): void {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return;

  ctx.bus.emit("provider:register", {
    id: "openai",
    apiKey,
    defaultModel: DEFAULT_MODELS[0],
    models: DEFAULT_MODELS,
  });
}
