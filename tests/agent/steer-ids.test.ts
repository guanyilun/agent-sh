/** Optional steering ids: re-steer edits in place, cancel targets by id. */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const DRIVER = fileURLToPath(new URL("../fixtures/steer-ids-driver.ts", import.meta.url));

function runDriver(): Promise<any> {
  const home = mkdtempSync(join(tmpdir(), "agent-sh-steer-ids-"));
  return new Promise((resolve, reject) => {
    const child = spawn("node", ["--import", "tsx", DRIVER], {
      env: {
        PATH: process.env.PATH, HOME: home, AGENT_SH_HOME: home, AGENT_SH_SKIP_SHELL_ENV: "1",
        OPENROUTER_API_KEY: "", OPENAI_API_KEY: "", DEEPSEEK_API_KEY: "", OPENAI_BASE_URL: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (c) => { stdout += c.toString(); });
    child.stderr!.on("data", (c) => { stderr += c.toString(); });
    const timer = setTimeout(() => child.kill("SIGKILL"), 30000);
    child.on("close", (code) => {
      clearTimeout(timer);
      rmSync(home, { recursive: true, force: true });
      try {
        resolve(JSON.parse(stdout.trim().split(/\r?\n/).pop() ?? ""));
      } catch (err) {
        reject(new Error(`driver output not JSON.\nexit=${code}\nstdout:\n${stdout}\nstderr:\n${stderr}\n${(err as Error).message}`));
      }
    });
  });
}

test("steering ids edit in place, cancel by id, and id-less cancel drops the last", async () => {
  const r = await runDriver();
  assert.deepEqual(r.queued, [
    { text: "A", id: "a", depth: 1 },
    { text: "B", id: "b", depth: 2 },
    { text: "A-edited", id: "a", depth: 2 },
    { text: "C", depth: 2 },
  ]);
  assert.deepEqual(r.dropped, [
    { texts: ["B"], ids: ["b"], reason: "cancelled" },
    { texts: ["C"], ids: [null], reason: "cancelled" },
  ]);
  assert.deepEqual(r.consumed, [{ text: "A-edited", id: "a" }]);
  assert.equal(r.requestCount, 2);
  assert.ok(r.userTexts.includes("A-edited") && !r.userTexts.some((t: string) => t === "A" || t === "B" || t === "C"),
    `only the edited steer reaches the model: ${JSON.stringify(r.userTexts)}`);
});
