/** Settings provider overlay refresh on agent:providers:changed. */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const DRIVER = fileURLToPath(new URL("../fixtures/provider-refresh-driver.ts", import.meta.url));

interface DriverResult {
  before?: string;
  afterEdit?: string;
  afterRemove?: string;
}

async function run(settings: Record<string, unknown>): Promise<DriverResult> {
  const home = mkdtempSync(join(tmpdir(), "agent-sh-prf-"));
  writeFileSync(join(home, "settings.json"), JSON.stringify(settings));
  try {
    return await new Promise<DriverResult>((resolve, reject) => {
      const child = spawn("node", ["--import", "tsx", DRIVER], {
        env: {
          PATH: process.env.PATH,
          HOME: home,
          AGENT_SH_HOME: home,
          AGENT_SH_SKIP_SHELL_ENV: "1",
          OPENROUTER_API_KEY: "",
          OPENAI_API_KEY: "",
          DEEPSEEK_API_KEY: "",
          OPENAI_BASE_URL: "",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout!.on("data", (c) => { stdout += c.toString(); });
      child.stderr!.on("data", (c) => { stderr += c.toString(); });
      const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
      child.on("close", (code) => {
        clearTimeout(timer);
        try {
          const line = stdout.trim().split(/\r?\n/).pop() ?? "";
          resolve(JSON.parse(line) as DriverResult);
        } catch (err) {
          reject(new Error(`driver output not JSON. exit=${code} stdout=${stdout} stderr=${stderr} err=${(err as Error).message}`));
        }
      });
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test("settings provider overlay refreshes on agent:providers:changed", async () => {
  const result = await run({
    defaultProvider: "myproxy",
    providers: { myproxy: { apiKey: "sk-old", baseURL: "https://proxy.local/v1", defaultModel: "m1" } },
  });
  assert.equal(result.before, "sk-old", "initial key should resolve");
  assert.equal(result.afterEdit, "sk-new", "edited key should take effect after reload + providers:changed");
  assert.equal(result.afterRemove, undefined, "removed provider should drop out of the overlay");
});
