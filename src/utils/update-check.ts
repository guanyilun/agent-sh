import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR } from "../core/settings.js";
import { PACKAGE_VERSION } from "./package-version.js";

const CACHE_PATH = path.join(CONFIG_DIR, "update-check.json");

interface UpdateCache {
  latest: string;
  checkedAt: number;
}

/**
 * Read cached update info. Returns { latest, current } if a newer version
 * was found within the last 7 days. Returns null otherwise.
 *
 * Designed for synchronous startup display — no network I/O.
 */
export function getPendingUpdate(): { latest: string; current: string } | null {
  try {
    const raw = fs.readFileSync(CACHE_PATH, "utf-8");
    const cache = JSON.parse(raw) as UpdateCache;
    if (!cache.latest || !cache.checkedAt) return null;

    // Stale cache — don't nag about old news.
    if (Date.now() - cache.checkedAt > 7 * 24 * 60 * 60 * 1000) return null;

    if (compareVersions(cache.latest, PACKAGE_VERSION) > 0) {
      return { latest: cache.latest, current: PACKAGE_VERSION };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Async check of the npm registry for the latest published version.
 * Writes result to cache file for next startup. Rate-limited to one
 * check per 24 hours. Network failures are silent no-ops.
 *
 * Call this after the shell is up — never await it at startup.
 */
export async function checkForUpdate(): Promise<void> {
  // Don't re-check if we already checked within 24 hours.
  try {
    const raw = fs.readFileSync(CACHE_PATH, "utf-8");
    const cache = JSON.parse(raw) as UpdateCache;
    if (Date.now() - cache.checkedAt < 24 * 60 * 60 * 1000) return;
  } catch {
    // No cache — proceed.
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const res = await fetch("https://registry.npmjs.org/agent-sh/latest", {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });

    if (!res.ok) return;
    const data = (await res.json()) as { version?: string };
    if (!data.version) return;

    const cache: UpdateCache = {
      latest: data.version,
      checkedAt: Date.now(),
    };

    fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
    fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2) + "\n");
  } catch {
    // Network error, DNS failure, timeout — all silent.
  } finally {
    clearTimeout(timeout);
  }
}

/** Compare semver strings. Positive if a > b, negative if a < b, 0 if equal. */
function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va !== vb) return va - vb;
  }
  return 0;
}
