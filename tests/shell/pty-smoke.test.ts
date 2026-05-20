/**
 * End-to-end PTY smoke test: spawn each installed shell under its strategy's
 * generated rc, run a single command, and assert that all three OSC markers
 * (PROMPT/PREEXEC/READY) appeared somewhere in the stream.
 *
 * This is intentionally minimal — we only assert markers fire, not what they
 * carry. Content of PREEXEC depends on history populating, fish prompt
 * rendering depends on TTY handshake, etc. — those are environment concerns
 * outside our regression scope. Skip cleanly when a shell isn't installed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as pty from "node-pty";
import { bashStrategy } from "../../src/shell/strategies/bash.js";
import { zshStrategy } from "../../src/shell/strategies/zsh.js";
import { fishStrategy } from "../../src/shell/strategies/fish.js";
import type { ShellStrategy } from "../../src/shell/strategies/index.js";

interface Spec {
  strategy: ShellStrategy;
  candidates: string[];
}

const SHELLS: Spec[] = [
  { strategy: bashStrategy, candidates: ["/bin/bash", "/usr/bin/bash", "/usr/local/bin/bash", "/opt/homebrew/bin/bash"] },
  { strategy: zshStrategy,  candidates: ["/bin/zsh",  "/usr/bin/zsh",  "/usr/local/bin/zsh",  "/opt/homebrew/bin/zsh"] },
  { strategy: fishStrategy, candidates: ["/usr/bin/fish", "/usr/local/bin/fish", "/opt/homebrew/bin/fish"] },
];

function findBinary(candidates: string[]): string | null {
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isFile()) return c;
    } catch { /* try next */ }
  }
  return null;
}

interface SmokeResult {
  data: string;
  reason: "all-markers" | "timeout" | "exit";
}

function smokeRun(shellBin: string, strategy: ShellStrategy, timeoutMs: number): Promise<SmokeResult> {
  const tmpDirRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-sh-pty-smoke-"));
  const userHome = process.env.HOME || os.homedir();
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }

  const cfg = strategy.prepareSpawn({
    tmpDirRoot,
    instanceTag: "id=smoketest",
    showIndicator: false,
    userHome,
    env,
  });
  Object.assign(env, cfg.envOverrides);

  const term = pty.spawn(shellBin, cfg.args, {
    name: "xterm-256color",
    cols: 80,
    rows: 24,
    cwd: userHome,
    env,
  });

  return new Promise((resolve) => {
    let data = "";
    let commandSent = false;
    let done = false;

    const PROMPT = /\x1b\]9999;id=smoketest;PROMPT\x07/g;
    const PREEXEC = /\x1b\]9997;id=smoketest;[^\x07]*\x07/;
    const READY = /\x1b\]9998;id=smoketest;READY\x07/;

    const cleanup = (reason: SmokeResult["reason"]): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { term.kill(); } catch { /* noop */ }
      fs.rmSync(tmpDirRoot, { recursive: true, force: true });
      if (cfg.tmpDir && cfg.tmpDir !== tmpDirRoot) {
        try { fs.rmSync(cfg.tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
      }
      resolve({ data, reason });
    };

    const timer = setTimeout(() => cleanup("timeout"), timeoutMs);

    term.onData((chunk) => {
      data += chunk;
      const promptCount = (data.match(PROMPT) ?? []).length;

      // First PROMPT means the initial prompt is up — send the command.
      if (!commandSent && promptCount >= 1) {
        commandSent = true;
        term.write("true\r");
      }

      // After our command, look for all three markers having appeared.
      if (commandSent && PROMPT.test(data) && PREEXEC.test(data) && READY.test(data)) {
        cleanup("all-markers");
      }
    });

    term.onExit(() => cleanup("exit"));
  });
}

for (const spec of SHELLS) {
  const bin = findBinary(spec.candidates);
  const skipReason = bin === null ? `${spec.strategy.name} not installed on this host` : false;

  test(`${spec.strategy.name}: live PTY emits PROMPT, PREEXEC, and READY markers`, { timeout: 20000, skip: skipReason }, async () => {
    const { data, reason } = await smokeRun(bin!, spec.strategy, 15000);

    const promptOk = /\x1b\]9999;id=smoketest;PROMPT\x07/.test(data);
    const preexecOk = /\x1b\]9997;id=smoketest;[^\x07]*\x07/.test(data);
    const readyOk = /\x1b\]9998;id=smoketest;READY\x07/.test(data);

    const detail = `reason=${reason}\nPROMPT seen: ${promptOk}\nPREEXEC seen: ${preexecOk}\nREADY seen: ${readyOk}\n--- captured (first 1KB) ---\n${data.slice(0, 1024)}`;

    assert.ok(promptOk, `PROMPT (OSC 9999) never observed\n${detail}`);
    assert.ok(preexecOk, `PREEXEC (OSC 9997) never observed\n${detail}`);
    assert.ok(readyOk, `READY (OSC 9998) never observed\n${detail}`);
  });
}
