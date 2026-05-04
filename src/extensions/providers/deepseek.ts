/**
 * Native DeepSeek reasoning shape. The provider is registered via
 * settings.json; this extension only attaches the right reasoning-param
 * builder so `/thinking off` actually disables thinking on V4 models.
 *
 * V4 ignores `reasoning_effort` for on/off — it uses a separate `thinking`
 * field that defaults to enabled.
 */
import type { ExtensionContext } from "../../types.js";

function buildReasoningParams(level: string): Record<string, unknown> {
  return level === "off"
    ? { thinking: { type: "disabled" } }
    : { thinking: { type: "enabled" }, reasoning_effort: level };
}

export default function activate(ctx: ExtensionContext): void {
  ctx.providers.configure("deepseek", { reasoningParams: buildReasoningParams });
}
