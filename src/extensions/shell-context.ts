/**
 * Shell context extension.
 *
 * Owns everything shell-related that the agent loop used to depend on:
 * tracking PTY commands and cwd, spilling long outputs, and contributing
 * the `<shell_events>` per-query envelope. Loads as a built-in so the
 * default agent-sh experience is unchanged, but a frontend without a
 * shell (e.g. agent-sh-hub) simply doesn't load it and the agent loop
 * runs cwd-aware via `process.cwd()`.
 *
 * Public surface:
 *   - advises  `cwd`                    — returns PTY-tracked cwd
 *   - producer `shell-events` (per-query) — emits <shell_events> delta
 *   - handler  `shell:context-recent`  — recent shell-command summary
 *   - handler  `shell:context-search`  — regex search over shell exchanges
 */
import type { ExtensionContext } from "../types.js";
import { getSettings } from "../settings.js";
import { spillOutput } from "../utils/shell-output-spill.js";

interface ShellExchange {
  id: number;
  timestamp: number;
  cwd: string;
  command: string;
  /** In-context representation: full text if short, head+tail+path stub if spilled. */
  output: string;
  exitCode: number | null;
  outputLines: number;
  outputBytes: number;
  source: "user" | "agent";
  spillPath?: string;
}

export default function activate(ctx: ExtensionContext): void {
  const { bus } = ctx;

  const exchanges: ShellExchange[] = [];
  let nextId = 1;
  let currentCwd = process.cwd();
  let agentShellActive = false;
  let lastSeq = 0;

  // ── Track PTY events ──────────────────────────────────────────
  bus.on("shell:command-done", (e) => {
    const lines = e.output.split("\n");
    const s = getSettings();

    // Spill long outputs to a tempfile so the agent can `read_file` them
    // on demand instead of carrying the full text in LLM context.
    let output = e.output;
    let spillPath: string | undefined;
    if (lines.length > s.shellTruncateThreshold) {
      const id = nextId;
      try {
        spillPath = spillOutput(id, e.output);
        output = buildSpillStub(lines, s.shellHeadLines, s.shellTailLines, spillPath);
      } catch {
        // Disk full / permission error — keep output in memory.
        output = e.output;
        spillPath = undefined;
      }
    }

    exchanges.push({
      id: nextId++,
      timestamp: Date.now(),
      cwd: e.cwd,
      command: e.command,
      output,
      exitCode: e.exitCode,
      outputLines: lines.length,
      outputBytes: e.output.length,
      source: agentShellActive ? "agent" : "user",
      spillPath,
    });
  });

  bus.on("shell:cwd-change", (e) => { currentCwd = e.cwd; });
  bus.on("shell:agent-exec-start", () => { agentShellActive = true; });
  bus.on("shell:agent-exec-done", () => { agentShellActive = false; });

  // ── cwd handler ───────────────────────────────────────────────
  // core defines a default returning process.cwd(); we override with
  // the PTY-tracked value.
  ctx.advise("cwd", () => currentCwd);

  // ── Per-query shell-events producer ───────────────────────────
  ctx.registerContextProducer("shell-events", () => {
    const fresh = exchanges.filter(
      (ex) => ex.id > lastSeq && ex.source !== "agent",
    );
    if (fresh.length === 0) return null;
    lastSeq = exchanges[exchanges.length - 1]!.id;

    const text = fresh.map(formatExchangeTruncated).filter(Boolean).join("\n");
    if (!text) return null;
    return `<shell_events>\n${text}\n</shell_events>`;
  }, { mode: "per-query" });

  // ── Recent + search handlers (consumed by peer-mesh and similar) ──
  ctx.define("shell:context-recent", (n: number = 25) => {
    const recent = exchanges.slice(-n);
    if (recent.length === 0) return "No exchanges yet.";
    return recent.map(exchangeOneLiner).join("\n");
  });

  ctx.define("shell:context-search", (query: string) => {
    if (!query.trim()) return "No query provided.";

    let regex: RegExp;
    try {
      regex = new RegExp(query, "i");
    } catch {
      const words = query.split(/\s+/).filter((w) => w.length > 0);
      regex = new RegExp(words.map(escapeRegex).join("|"), "i");
    }

    const matches: { exchange: ShellExchange; excerpts: string[] }[] = [];
    for (const ex of exchanges) {
      const text = `${ex.command}\n${ex.output}`;
      const lines = text.split("\n");
      const matchingIndices: number[] = [];
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i]!)) matchingIndices.push(i);
      }
      if (matchingIndices.length > 0) {
        const excerpts = matchingIndices.slice(0, 5).map((idx) => {
          const start = Math.max(0, idx - 2);
          const end = Math.min(lines.length, idx + 3);
          return lines.slice(start, end).join("\n");
        });
        matches.push({ exchange: ex, excerpts });
      }
    }

    if (matches.length === 0) return `No results found for "${query}".`;
    const parts: string[] = [`Search results for "${query}" (${matches.length} exchanges):\n`];
    for (const m of matches.slice(0, 20)) {
      parts.push(`#${m.exchange.id} [shell_command]`);
      for (const excerpt of m.excerpts) parts.push(indent(excerpt, "  "));
      parts.push("");
    }
    return parts.join("\n");
  });
}

// ── Internal helpers ───────────────────────────────────────────

function formatExchangeTruncated(ex: ShellExchange): string {
  const label = ex.source === "agent" ? "agent → shell" : "shell";
  let s = `#${ex.id} [${label} cwd:${ex.cwd}] $ ${ex.command}\n`;
  if (ex.output) s += indent(ex.output, "  ") + "\n";
  if (ex.exitCode !== null) s += `  exit ${ex.exitCode}\n`;
  return s;
}

function exchangeOneLiner(ex: ShellExchange): string {
  const label = ex.source === "agent" ? "agent → shell" : "shell";
  return `#${ex.id} ${label} [cwd:${ex.cwd}]: ${ex.command} (${ex.outputLines} total lines, exit ${ex.exitCode ?? "?"})`;
}

function buildSpillStub(
  lines: string[],
  headLines: number,
  tailLines: number,
  spillPath: string,
): string {
  const omitted = lines.length - headLines - tailLines;
  return [
    ...lines.slice(0, headLines),
    `[... ${omitted} lines truncated — full output at ${spillPath}; use read_file to expand ...]`,
    ...lines.slice(-tailLines),
  ].join("\n");
}

function indent(text: string, prefix: string): string {
  return text.split("\n").map((line) => prefix + line).join("\n");
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
