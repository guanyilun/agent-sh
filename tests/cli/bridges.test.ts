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
  signal: NodeJS.Signals | null;
  stderr: string;
  stdout: string;
}

function freshHome(): string {
  return mkdtempSync(join(tmpdir(), "agent-sh-bridge-"));
}

function runOnce(args: string[], home: string, timeoutMs: number): Promise<RunResult> {
  return new Promise<RunResult>((resolve) => {
    const child = spawn("node", [CLI, ...args], {
      env: {
        PATH: process.env.PATH,
        HOME: home,
        AGENT_SH_HOME: home,
        AGENT_SH_SKIP_SHELL_ENV: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    let stdout = "";
    child.stderr!.on("data", (c) => { stderr += c.toString(); });
    child.stdout!.on("data", (c) => { stdout += c.toString(); });
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stderr, stdout });
    });
  });
}

function runUntilBanner(args: string[], home: string, timeoutMs = 30000): Promise<RunResult> {
  return new Promise<RunResult>((resolve) => {
    const child = spawn("node", [CLI, ...args], {
      env: {
        PATH: process.env.PATH,
        HOME: home,
        AGENT_SH_HOME: home,
        AGENT_SH_SKIP_SHELL_ENV: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    let stdout = "";
    let bannerSeen = false;
    const hardTimer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.stdout!.on("data", (c) => {
      stdout += c.toString();
      if (!bannerSeen && /Backend:\s+\S/.test(stdout)) {
        bannerSeen = true;
        // Give the async activateBackend a beat to either succeed or surface
        // its own error before we tear down.
        setTimeout(() => child.kill("SIGTERM"), 500);
      }
    });
    child.stderr!.on("data", (c) => { stderr += c.toString(); });
    child.on("close", (code, signal) => {
      clearTimeout(hardTimer);
      resolve({ code, signal, stderr, stdout });
    });
  });
}

// Strip terminal control sequences so stdout matches survive color codes / cursor moves.
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

const BRIDGES: Array<{ ext: string; backend: string }> = [
  { ext: "pi-bridge", backend: "pi" },
  { ext: "opencode-bridge", backend: "opencode" },
  { ext: "claude-code-bridge", backend: "claude-code" },
];

for (const { ext, backend } of BRIDGES) {
  test(`${ext} installs and the CLI reaches the banner under --backend ${backend}`, { timeout: 120000 }, async () => {
    const home = freshHome();
    try {
      const inst = await runOnce(["install", ext], home, 90000);
      assert.equal(inst.code, 0, `install failed:\nstdout: ${inst.stdout}\nstderr: ${inst.stderr}`);

      const launch = await runUntilBanner(["--backend", backend], home, 30000);
      const cleanStdout = stripAnsi(launch.stdout);
      const cleanStderr = stripAnsi(launch.stderr);

      assert.match(cleanStdout, new RegExp(`Backend:\\s+${backend}`), `banner missing.\nstdout: ${cleanStdout}\nstderr: ${cleanStderr}`);
      assert.doesNotMatch(cleanStderr, /Cannot find module/i, cleanStderr);
      assert.doesNotMatch(cleanStderr, /SyntaxError/, cleanStderr);
      assert.doesNotMatch(cleanStderr, /UnhandledPromiseRejection/, cleanStderr);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
}
