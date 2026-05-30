// Rendering-flow inspector, off unless ASHI_INSPECT is set (=1 writes to
// $TMPDIR/ashi-inspect.log, or set it to a path). It captures the three things
// that pin a React render loop: the "Maximum update depth" warning with its
// stack, any re-entrant store bump (a bump fired *during* a flush is the loop
// signature), and the per-commit render count via a Profiler. Append-only JSONL.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const env = process.env.ASHI_INSPECT;
export const INSPECT_FILE: string | null = env
  ? env === "1" ? path.join(os.tmpdir(), "ashi-inspect.log") : env
  : null;

let seq = 0;
export function inspectLog(event: string, data?: Record<string, unknown>): void {
  if (!INSPECT_FILE) return;
  try {
    fs.appendFileSync(INSPECT_FILE, JSON.stringify({ seq: seq++, event, ...data }) + "\n");
  } catch { /* inspector must never break the app */ }
}

const shortStack = (): string =>
  (new Error().stack ?? "").split("\n").slice(2, 16).map((l) => l.trim()).join(" | ");

/** Wrap console.error to record the loop warning with a stack, then pass through. */
export function inspectConsole(): void {
  if (!INSPECT_FILE) return;
  const orig = console.error.bind(console);
  console.error = (...args: unknown[]): void => {
    const msg = args.map((a) => (typeof a === "string" ? a : (a as Error)?.stack ?? String(a))).join(" ");
    if (msg.includes("Maximum update depth")) {
      inspectLog("max-update-depth", { msg: msg.slice(0, 4000), jsStack: shortStack() });
    }
    orig(...args);
  };
}

/** A render burst: many commits in a tight window points at the looping subtree. */
export function makeCommitWatcher(): (id: string, phase: string, actualMs: number) => void {
  let windowStart = 0;
  let windowCount = 0;
  return (id, phase, actualMs) => {
    if (!INSPECT_FILE) return;
    const now = performance.now();
    if (now - windowStart > 250) {
      if (windowCount > 30) inspectLog("render-burst", { commits: windowCount, ms: Math.round(now - windowStart) });
      windowStart = now;
      windowCount = 0;
    }
    windowCount++;
    if (windowCount === 60) inspectLog("render-burst-live", { phase, actualMs: Math.round(actualMs) });
  };
}

/** Note a store bump that fired while a flush was in progress — i.e. a render- or
 *  effect-phase mutation, which is exactly how a setState-in-effect loop forms. */
export function inspectReentrantBump(): void {
  inspectLog("reentrant-bump", { jsStack: shortStack() });
}
