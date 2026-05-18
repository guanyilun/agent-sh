/**
 * Z.AI Coding Plan — Zhipu AI's subscription GLM models for coding tools.
 *
 * Auth:  agent-sh auth login zai-coding-plan
 * Usage: agent-sh -e ./examples/extensions/zai-coding-plan.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { AgentContext } from "agent-sh/types";

const BASE_URL = "https://api.z.ai/api/coding/paas/v4";
const ID = "zai-coding-plan";

const DEFAULT_MODELS = [
  { id: "glm-5.1",     reasoning: true, contextWindow: 200_000 },
  { id: "glm-5-turbo", reasoning: true, contextWindow: 200_000 },
  { id: "glm-4.7",     reasoning: true, contextWindow: 204_800 },
  { id: "glm-4.5-air", reasoning: true, contextWindow: 131_072 },
];

function configDir(): string {
  return process.env.AGENT_SH_HOME ?? path.join(os.homedir(), ".agent-sh");
}

function resolveKey(): string | undefined {
  // settings.json → keys.json → env
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(configDir(), "settings.json"), "utf-8")) as Record<string, unknown>;
    const ext = raw[ID];
    if (ext && typeof ext === "object" && !Array.isArray(ext)) {
      const cfg = ext as Record<string, unknown>;
      if (typeof cfg.apiKey === "string" && cfg.apiKey) return cfg.apiKey;
    }
  } catch { /* missing */ }

  try {
    const keys = JSON.parse(fs.readFileSync(path.join(configDir(), "keys.json"), "utf-8")) as Record<string, string>;
    if (keys[ID]) return keys[ID];
  } catch { /* missing */ }

  return process.env.ZAI_API_KEY ?? process.env.ZHIPU_API_KEY;
}

function buildReasoningParams(level: string, _model?: string): Record<string, unknown> {
  if (level === "off") return { thinking: { type: "disabled" } };
  return { thinking: { type: "enabled" }, reasoning_effort: level };
}

export default function activate(ctx: AgentContext): void {
  const apiKey = resolveKey();
  if (!apiKey) return;

  ctx.agent.providers.configure(ID, { reasoningParams: buildReasoningParams });

  ctx.bus.emit("provider:register", {
    id: ID,
    apiKey,
    baseURL: BASE_URL,
    defaultModel: DEFAULT_MODELS[0].id,
    models: DEFAULT_MODELS,
  });
}
