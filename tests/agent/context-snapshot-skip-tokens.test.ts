import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const DRIVER = fileURLToPath(new URL("../fixtures/context-snapshot-skip-tokens-driver.ts", import.meta.url));

interface DriverResult { messages: number; plain: number; skipped: number }

function runDriver(): Promise<DriverResult> {
  const home = mkdtempSync(join(tmpdir(), "agent-sh-snapshot-"));
  return new Promise<DriverResult>((resolve, reject) => {
    const child = spawn("node", ["--import", "tsx", DRIVER], {
      env: {
        PATH: process.env.PATH,
        HOME: home,
        AGENT_SH_HOME: home,
        AGENT_SH_SKIP_SHELL_ENV: "1",
        OPENROUTER_API_KEY: "",
        OPENAI_API_KEY: "",
        DEEPSEEK_API_KEY: "",
        ZAI_API_KEY: "",
        OPENAI_BASE_URL: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (c) => { stdout += c.toString(); });
    child.stderr!.on("data", (c) => { stderr += c.toString(); });
    const timer = setTimeout(() => child.kill("SIGKILL"), 20000);
    child.on("close", (code) => {
      clearTimeout(timer);
      rmSync(home, { recursive: true, force: true });
      try {
        resolve(JSON.parse(stdout.trim().split(/\r?\n/).pop() ?? "") as DriverResult);
      } catch (err) {
        reject(new Error(`driver output not JSON.\nexit=${code}\nstdout:\n${stdout}\nstderr:\n${stderr}\n${(err as Error).message}`));
      }
    });
  });
}

// Callers that only want the message list (asHub's capture path) should not pay
// for a full-conversation token estimate on every turn.
test("context:snapshot honours skipTokens while keeping the default estimate", async () => {
  const result = await runDriver();
  assert.ok(result.messages > 0, `driver should have produced a non-empty conversation, got ${result.messages}`);
  assert.ok(result.plain > 0, `default snapshot should still estimate tokens, got ${result.plain}`);
  assert.equal(result.skipped, 0, "skipTokens should report activeTokens 0");
});
