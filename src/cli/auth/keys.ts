// Resolution order: settings.json → keys.json → env var.
import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR, getSettings, expandEnvVars } from "../../core/settings.js";

export const KEYS_PATH = path.join(CONFIG_DIR, "keys.json");

export interface ProviderAuthInfo {
  id: string;
  label: string;
  /** Conventional env var. Absent for user-declared providers. */
  envVar?: string;
  /** True for entries declared in settings.json (vs. a built-in). */
  custom?: boolean;
  /** True for ids only present in keys.json — likely owned by an extension
   *  that registers a provider at runtime. */
  unattached?: boolean;
  /** True when the registering provider declared `noAuth: true` (local
   *  daemons etc.). Auth UI shows "no auth required" instead of
   *  "not configured". */
  noAuth?: boolean;
}

export const KNOWN_PROVIDERS: ProviderAuthInfo[] = [
  { id: "openai",     label: "OpenAI",     envVar: "OPENAI_API_KEY" },
  { id: "openrouter", label: "OpenRouter", envVar: "OPENROUTER_API_KEY" },
  { id: "deepseek",   label: "DeepSeek",   envVar: "DEEPSEEK_API_KEY" },
];

/** Built-ins merged with settings-declared providers, plus any ids that only
 *  appear in keys.json (likely registered by an extension at runtime).
 *  Cheap synchronous path — does not load extensions. */
export function listAllProviders(): ProviderAuthInfo[] {
  const out: ProviderAuthInfo[] = [...KNOWN_PROVIDERS];
  const seen = new Set(out.map((p) => p.id));
  const settingsProviders = getSettings().providers ?? {};
  for (const id of Object.keys(settingsProviders)) {
    if (seen.has(id)) continue;
    out.push({ id, label: id, custom: true });
    seen.add(id);
  }
  for (const id of Object.keys(loadKeysFile())) {
    if (seen.has(id)) continue;
    out.push({ id, label: id, unattached: true });
    seen.add(id);
  }
  return out;
}

/** Same as listAllProviders but also bootstraps a throwaway core to
 *  enumerate provider IDs contributed by built-in + user extensions.
 *  Use from interactive CLI paths (`auth list`, `auth login`). */
export async function listAllProvidersWithDiscovery(): Promise<ProviderAuthInfo[]> {
  const out = listAllProviders();
  const byId = new Map(out.map((p) => [p.id, p] as const));
  const { discoverExtensionProviders } = await import("./discover.js");
  try {
    for (const d of await discoverExtensionProviders()) {
      const existing = byId.get(d.id);
      if (existing) {
        // Propagate noAuth onto a row that came from settings/keys.json.
        if (d.noAuth && !existing.noAuth) existing.noAuth = true;
        continue;
      }
      const entry: ProviderAuthInfo = { id: d.id, label: d.id, custom: true, noAuth: d.noAuth };
      out.push(entry);
      byId.set(d.id, entry);
    }
  } catch { /* discovery is best-effort */ }
  return out;
}

/** Resolve an id against known + settings entries only. Returns null for
 *  unattached or unknown ids — callers decide whether to accept them. */
export function findProvider(id: string): ProviderAuthInfo | null {
  const lower = id.toLowerCase();
  const known = KNOWN_PROVIDERS.find((p) => p.id === lower);
  if (known) return known;
  const settings = getSettings().providers ?? {};
  if (lower in settings) return { id: lower, label: lower, custom: true };
  return null;
}

export type KeySource = "settings" | "keys-file" | "env" | "none";

export interface ResolvedKey {
  key: string | null;
  source: KeySource;
}

type KeysFile = Record<string, string>;

let cached: KeysFile | null = null;

export function loadKeysFile(): KeysFile {
  if (cached) return cached;
  try {
    const raw = fs.readFileSync(KEYS_PATH, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      cached = parsed as KeysFile;
    } else {
      cached = {};
    }
  } catch (err) {
    if (err instanceof SyntaxError) {
      console.error(`[agent-sh] Warning: invalid JSON in ${KEYS_PATH}: ${err.message}`);
    }
    cached = {};
  }
  return cached;
}

export function saveKeysFile(keys: KeysFile): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const tmp = `${KEYS_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(keys, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, KEYS_PATH);
  try { fs.chmodSync(KEYS_PATH, 0o600); } catch { /* best effort */ }
  cached = { ...keys };
}

export function reloadKeysFile(): void {
  cached = null;
}

export function resolveApiKey(providerId: string): ResolvedKey {
  const settingsKey = getSettings().providers?.[providerId]?.apiKey;
  if (settingsKey) {
    const expanded = expandEnvVars(settingsKey);
    if (expanded) return { key: expanded, source: "settings" };
  }

  const fileKey = loadKeysFile()[providerId];
  if (fileKey) return { key: fileKey, source: "keys-file" };

  const info = KNOWN_PROVIDERS.find((p) => p.id === providerId);
  if (info?.envVar) {
    const envKey = process.env[info.envVar];
    if (envKey) return { key: envKey, source: "env" };
  }

  return { key: null, source: "none" };
}

export function anyProviderConfigured(): boolean {
  // openai-compatible activates on OPENAI_BASE_URL alone (keyless local servers).
  if (process.env.OPENAI_BASE_URL) return true;
  return listAllProviders().some((p) => resolveApiKey(p.id).key);
}
