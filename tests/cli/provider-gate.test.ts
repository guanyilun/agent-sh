import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../../dist/cli/index.js", import.meta.url));

interface RunResult {
  code: number | null;
  stderr: string;
  stdout: string;
}

function runCli(args: string[], extraEnv: Record<string, string> = {}): Promise<RunResult> {
  const home = mkdtempSync(join(tmpdir(), "agent-sh-test-"));
  return new Promise<RunResult>((resolve) => {
    const child = spawn("node", [CLI, ...args], {
      env: {
        PATH: process.env.PATH,
        HOME: home,
        AGENT_SH_SKIP_SHELL_ENV: "1",
        ...extraEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    let stdout = "";
    child.stderr!.on("data", (c) => { stderr += c.toString(); });
    child.stdout!.on("data", (c) => { stdout += c.toString(); });
    const timer = setTimeout(() => child.kill("SIGTERM"), 800);
    child.on("close", (code) => {
      clearTimeout(timer);
      try { rmSync(home, { recursive: true, force: true }); } catch {}
      resolve({ code, stderr, stdout });
    });
  });
}

test("ash backend with no provider configured fires the gate", async () => {
  const { code, stderr } = await runCli([]);
  assert.equal(code, 1, `expected exit 1, got ${code}\nstderr: ${stderr}`);
  assert.match(stderr, /no LLM provider configured/);
});

test("--backend pi with no provider configured skips the gate (regression for #178)", async () => {
  const { stderr } = await runCli(["--backend", "pi"]);
  assert.doesNotMatch(stderr, /no LLM provider configured/, stderr);
});

test("ash backend with OPENAI_API_KEY in env skips the gate", async () => {
  const { stderr } = await runCli([], { OPENAI_API_KEY: "sk-test-not-real" });
  assert.doesNotMatch(stderr, /no LLM provider configured/, stderr);
});

test("ash backend with --api-key skips the gate", async () => {
  const { stderr } = await runCli(["--api-key", "sk-test-not-real"]);
  assert.doesNotMatch(stderr, /no LLM provider configured/, stderr);
});
