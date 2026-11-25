import type { AgentContext } from "../host-types.js";
import { resolveApiKey } from "../../cli/auth/keys.js";

const DEFAULT_MODEL = "claude-sonnet-5-5";
// https://platform.claude.com/docs/en/models/overview
const MODELS = [DEFAULT_MODEL, "claude-opus-5-5", "claude-haiku-5-5"].map((id) => ({
  id,
  contextWindow: 1_000_000,
  maxTokens: 128_000,
  modalities: ["text", "image"] as ("text" | "image")[],
  reasoning: true,
}));

export default function activate(ctx: AgentContext): void {
  ctx.agent.providers.register({
    id: "anthropic",
    get apiKey() { return resolveApiKey("anthropic").key ?? undefined; },
    baseURL: "https://api.anthropic.com/v1",
    defaultModel: DEFAULT_MODEL,
    models: MODELS,
    // The compatibility API ignores reasoning_effort. Claude 5 uses its own
    // adaptive thinking defaults; ash does not expose effort control here.
    supportsReasoningEffort: false,
  });
}
