/**
 * Integration test: Shell routes PTY I/O through its injected Terminal,
 * not through process.stdin/stdout.
 *
 * The refactor's central invariant — "Shell never reaches for process.*" —
 * is hard to prove by reading the code (the next refactor could regress it
 * silently). This test wires a real PTY but swaps in a recording fake
 * Terminal, then asserts:
 *   - PTY output reaches the fake's write()
 *   - suspendInput() is called around pty.spawn (and resumed after)
 *   - process.stdout.write is never invoked from Shell while alive
 * Skipped when no bash is installed (matches pty-smoke).
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import { EventBus } from "../../src/core/event-bus.js";
import { Shell, type ShellHandlers } from "../../src/shell/shell.js";
import type { Terminal } from "../../src/shell/terminal.js";

interface Recording {
  writes: string[];
  inputs: Array<(s: string) => void>;
  suspendCallCount: number;
  resumeCallCount: number;
}

function makeFakeTerminal(): Terminal & { _rec: Recording } {
  const rec: Recording = { writes: [], inputs: [], suspendCallCount: 0, resumeCallCount: 0 };
  return {
    write(data) { rec.writes.push(data); },
    onInput(cb) {
      rec.inputs.push(cb);
      return () => {
        const i = rec.inputs.indexOf(cb);
        if (i >= 0) rec.inputs.splice(i, 1);
      };
    },
    onResize(_cb) { return () => {}; },
    cols() { return 80; },
    rows() { return 24; },
    suspendInput() {
      rec.suspendCallCount++;
      return { resume: () => { rec.resumeCallCount++; } };
    },
    _rec: rec,
  };
}

function makeHandlers(): ShellHandlers {
  const fns = new Map<string, (...a: unknown[]) => unknown>();
  return {
    define(name, fn) { fns.set(name, fn as (...a: unknown[]) => unknown); },
    call(name, ...args) {
      const fn = fns.get(name);
      return fn ? fn(...args) : undefined;
    },
  };
}

function findBash(): string | null {
  for (const p of ["/bin/bash", "/usr/bin/bash", "/usr/local/bin/bash", "/opt/homebrew/bin/bash"]) {
    try { if (fs.statSync(p).isFile()) return p; } catch { /* try next */ }
  }
  return null;
}

const bash = findBash();
const skipReason = bash === null ? "bash not installed" : false;

test("Shell routes PTY output to terminal.write, never to process.stdout", { timeout: 10000, skip: skipReason }, async () => {
  const fake = makeFakeTerminal();

  // Hijack process.stdout.write to detect any stray writes from Shell.
  const realWrite = process.stdout.write.bind(process.stdout);
  const stdoutLeaks: string[] = [];
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
    // Allow node:test reporter writes (tap output goes through here too).
    // We only flag chunks that look like raw PTY bytes from our bash —
    // anything containing an OSC marker or terminal escape from the shell.
    const s = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8");
    if (/\x1b\][0-9]+;/.test(s) || /AGENT_SH_BASH_OK/.test(s)) {
      stdoutLeaks.push(s);
    }
    /* eslint-disable @typescript-eslint/no-explicit-any */
    return (realWrite as any)(chunk, ...rest);
    /* eslint-enable @typescript-eslint/no-explicit-any */
  }) as typeof process.stdout.write;

  const bus = new EventBus();
  const handlers = makeHandlers();
  const shell = new Shell({
    bus,
    handlers,
    cols: 80,
    rows: 24,
    shell: bash!,
    cwd: os.homedir(),
    instanceId: "shell-terminal-test",
    terminal: fake,
  });

  try {
    // suspendInput must fire exactly once around pty.spawn, and resume must
    // fire after it. The Shell constructor is the only place this happens.
    assert.equal(fake._rec.suspendCallCount, 1, "suspendInput should be called exactly once during construction");
    assert.equal(fake._rec.resumeCallCount, 1, "resume should be called after pty.spawn");

    // onInput must be subscribed so keystrokes from the terminal can flow in.
    assert.ok(fake._rec.inputs.length >= 1, "Shell should subscribe to terminal.onInput");

    // Wait for the bash prompt + our marker to come back through the PTY.
    // Write a sentinel via the bus pty-write API and look for it in fake.write.
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout waiting for PTY output through fake terminal")), 8000);
      const tick = () => {
        const combined = fake._rec.writes.join("");
        if (combined.includes("AGENT_SH_BASH_OK")) {
          clearTimeout(timer);
          resolve();
        } else {
          setTimeout(tick, 50);
        }
      };
      // Wait one tick for PTY to come up, then send the sentinel.
      setTimeout(() => {
        bus.emit("shell:pty-write", { data: "echo AGENT_SH_BASH_OK\r" });
        tick();
      }, 200);
    });

    assert.ok(fake._rec.writes.length > 0, "PTY output should reach terminal.write");
    assert.equal(stdoutLeaks.length, 0, `Shell leaked PTY bytes to process.stdout:\n${stdoutLeaks.join("\n---\n").slice(0, 500)}`);
  } finally {
    process.stdout.write = realWrite as typeof process.stdout.write;
    shell.kill();
  }
});
