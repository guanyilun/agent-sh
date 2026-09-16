/** Model catalog: the Codex client's ~/.codex/models_cache.json, else a static fallback. */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

type Modality = "text" | "image";

export interface CodexModel {
  id: string;
  reasoning: boolean;
  /** Required for the reasoning_details replay. */
  echoReasoning: boolean;
  contextWindow: number;
  modalities?: Modality[];
}

const FALLBACK_MODELS = ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini"];
const DEFAULT_CONTEXT_WINDOW = 272_000;

export function codexCachePath(): string {
  return path.join(os.homedir(), ".codex", "models_cache.json");
}

function toModel(id: string, contextWindow?: unknown, input?: unknown): CodexModel {
  const modalities: Modality[] = Array.isArray(input)
    ? input.filter((m): m is Modality => m === "text" || m === "image")
    : ["text", "image"];
  return {
    id,
    reasoning: true,
    echoReasoning: true,
    contextWindow: typeof contextWindow === "number" && contextWindow > 0 ? contextWindow : DEFAULT_CONTEXT_WINDOW,
    modalities: modalities.length ? modalities : undefined,
  };
}

/** Listed (user-selectable) models from the Codex cache; [] if unreadable. */
export function readCodexCache(file = codexCachePath()): CodexModel[] {
  let data: { models?: Array<Record<string, unknown>> };
  try {
    data = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return [];
  }
  const out: CodexModel[] = [];
  for (const m of data.models ?? []) {
    if (typeof m.slug !== "string" || m.visibility !== "list") continue;
    out.push(toModel(m.slug, m.context_window, m.input_modalities));
  }
  return out;
}

export function resolveModels(configured: string[] = [], cacheFile?: string): CodexModel[] {
  if (configured.length) return configured.map((id) => toModel(id));
  const cached = readCodexCache(cacheFile);
  return cached.length ? cached : FALLBACK_MODELS.map((id) => toModel(id));
}
