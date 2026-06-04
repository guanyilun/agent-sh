import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { pickStrategy, FALLBACK_STRATEGY, type ShellStrategy } from "../shell/strategies/index.js";
import { CONFIG_DIR } from "../core/settings.js";

const CACHE_FILE = path.join(CONFIG_DIR, "cache", "shell-env.json");

function captureSignature(shell: string, strategy: ShellStrategy, captureCmd: string): string {
  const files = strategy.envCaptureFiles?.(process.env) ?? [];
  const stamps = files.sort().map((f) => {
    try {
      return [f, fs.statSync(f).mtimeMs];
    } catch {
      return [f, 0];
    }
  });
  return JSON.stringify({ shell, captureCmd, stamps });
}

function readCachedEnv(sig: string): Record<string, string> | null {
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8"));
    if (raw?.sig === sig && raw.env && typeof raw.env === "object") return raw.env;
  } catch {}
  return null;
}

function writeCachedEnv(sig: string, env: Record<string, string>): void {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ sig, env }));
  } catch {}
}

export async function captureShellEnvAsync(shell: string): Promise<Record<string, string>> {
  if (process.env.AGENT_SH_SKIP_SHELL_ENV) return {};

  const strategy = pickStrategy(shell) ?? FALLBACK_STRATEGY;
  const captureCmd = strategy.envCaptureCommand();
  const sig = captureSignature(shell, strategy, captureCmd);

  if (!process.env.AGENT_SH_SHELL_ENV_NOCACHE) {
    const cached = readCachedEnv(sig);
    if (cached) return cached;
  }

  return new Promise((resolve) => {
    let settled = false;
    const done = (result: Record<string, string>): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    try {
      const child = spawn(shell, ["-l", "-c", captureCmd], {
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5000,
      });

      let output = "";
      child.stdout?.on("data", (data) => {
        output += data.toString("utf-8");
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0 || !output) {
          done({});
          return;
        }
        const env: Record<string, string> = {};
        for (const entry of output.split("\0")) {
          const eq = entry.indexOf("=");
          if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1);
        }
        writeCachedEnv(sig, env);
        done(env);
      });

      child.on("error", () => {
        clearTimeout(timer);
        done({});
      });

      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        done({});
      }, 5000);
    } catch {
      done({});
    }
  });
}

export function mergeShellEnv(
  baseEnv: Record<string, string>,
  shellEnv: Record<string, string>,
): Record<string, string> {
  const merged = { ...baseEnv };
  for (const [key, value] of Object.entries(shellEnv)) {
    if (!(key in merged) || !merged[key]) {
      merged[key] = value;
    }
  }
  return merged;
}
