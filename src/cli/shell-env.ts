import { spawn } from "node:child_process";
import { pickStrategy, FALLBACK_STRATEGY } from "../shell/strategies/index.js";

export async function captureShellEnvAsync(shell: string): Promise<Record<string, string>> {
  if (process.env.AGENT_SH_SKIP_SHELL_ENV) return {};
  return new Promise((resolve) => {
    let settled = false;
    const done = (result: Record<string, string>): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    try {
      const strategy = pickStrategy(shell) ?? FALLBACK_STRATEGY;
      const captureCmd = strategy.envCaptureCommand();

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
