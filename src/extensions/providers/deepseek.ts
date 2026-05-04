/**
 * Native DeepSeek reasoning shape. V4 ignores reasoning_effort for on/off
 * — disable lives in a separate `thinking` field that defaults to enabled.
 * Provider registration stays driven by settings.json.
 */
import type { ExtensionContext } from "../../types.js";

function buildReasoningParams(level: string, _model?: string): Record<string, unknown> {
  return level === "off"
    ? { thinking: { type: "disabled" } }
    : { thinking: { type: "enabled" }, reasoning_effort: level };
}

export default function activate(ctx: ExtensionContext): void {
  ctx.providers.configure("deepseek", { reasoningParams: buildReasoningParams });
}
