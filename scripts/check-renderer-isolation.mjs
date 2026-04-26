#!/usr/bin/env node
/**
 * Guard: process.stdout / process.stdin must only appear in files that
 * are allowed to be terminal-coupled. Anything else means a renderer
 * leak — a web/DOM/IDE renderer would have to fork core to fix it.
 *
 * Run with:  node scripts/check-renderer-isolation.mjs
 * Exits 1 (failing CI) on any unauthorized reference.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../src", import.meta.url));

// Files allowed to read/write process.stdout or process.stdin.
// Each entry is justified — if you add one, add the reason inline.
const ALLOWED = new Set([
  "utils/compositor.ts",        // StdoutSurface — the only sanctioned bridge
  "utils/terminal-buffer.ts",   // xterm-headless dim-background, TUI-only
  "shell/shell.ts",             // PTY plumbing, legitimately terminal
  "index.ts",                   // TUI entry point — wires shell.resize from tty
]);

const PATTERN = /\bprocess\.(stdout|stdin)\b/;

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const s = statSync(full);
    if (s.isDirectory()) yield* walk(full);
    else if (full.endsWith(".ts")) yield full;
  }
}

const violations = [];
for (const file of walk(ROOT)) {
  const rel = relative(ROOT, file);
  if (ALLOWED.has(rel)) continue;
  const text = readFileSync(file, "utf-8");
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (PATTERN.test(lines[i])) {
      violations.push(`${rel}:${i + 1}: ${lines[i].trim()}`);
    }
  }
}

if (violations.length === 0) {
  console.log("renderer isolation: ok");
  process.exit(0);
}

console.error("renderer isolation: violations found\n");
for (const v of violations) console.error("  " + v);
console.error(
  "\nprocess.stdout / process.stdin should only be referenced from " +
  [...ALLOWED].join(", ") + ".",
);
console.error(
  "Route writes through RenderSurface (utils/compositor.ts) and " +
  "viewport reads through surface.columns / surface.rows / surface.onResize.",
);
process.exit(1);
