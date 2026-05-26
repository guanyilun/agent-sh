/** Regression coverage for the "fresh install + `auth login deepseek` →
 *  no backend found" bug. Two invariants:
 *    1. Built-ins still register without a key (auth-discovery feature).
 *    2. With only one keyed provider, the ash backend activates against it
 *       — the default-provider fallback must skip keyless entries. */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const DRIVER = fileURLToPath(new URL("../fixtures/builtin-provider-driver.ts", import.meta.url));

interface DriverResult {
  registeredIds: string[];
  backendRegistrations: { name: string }[];
}

async function run(opts: {
  keys?: Record<string, string>;
  settings?: Record<string, unknown>;
}): Promise<DriverResult> {
  const home = mkdtempSync(join(tmpdir(), "agent-sh-bpa-"));
  writeFileSync(join(home, "settings.json"), JSON.stringify(opts.settings ?? {}));
  if (opts.keys) writeFileSync(join(home, "keys.json"), JSON.stringify(opts.keys));
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

test("no keys configured: built-in providers still register for auth discovery", async () => {
  const result = await run({});
  // discoverExtensionProviders() depends on these registering even without
  // a key, so the auth login picker can list unconfigured built-ins.
  assert.ok(result.registeredIds.includes("openrouter"));
  assert.ok(result.registeredIds.includes("openai"));
  assert.ok(result.registeredIds.includes("deepseek"));
});

test("only deepseek keyed: ash backend registers against deepseek", async () => {
  const result = await run({ keys: { deepseek: "sk-test" } });
  const ash = result.backendRegistrations.find((b) => b.name === "ash");
  assert.ok(ash, `ash backend did not register; got ${JSON.stringify(result.backendRegistrations)}`);
});

test("only deepseek keyed but settings.defaultProvider=openrouter: ash does not register", async () => {
  // Explicit user choice must still win — this guards against an overly
  // aggressive fallback that ignores defaultProvider.
  const result = await run({
    keys: { deepseek: "sk-test" },
    settings: { defaultProvider: "openrouter" },
  });
  const ash = result.backendRegistrations.find((b) => b.name === "ash");
  assert.equal(ash, undefined, "ash should not register when user pointed at keyless openrouter");
});
