/** Tracks PTY commands and cwd, spills long outputs, contributes per-query
 *  `<shell_events>` (fresh user exchanges) and — under the shell frontend —
 *  `<cwd>`. Frontends without a PTY skip this. */
import type { ExtensionContext } from "./host-types.js";
import { getSettings } from "../core/settings.js";
import { spillOutput } from "../utils/shell-output-spill.js";

// The cwd-drift note applies only under the shell frontend (where the agent shares
// the user's cwd); other frontends own a fixed cwd.
const SHELL_EVENTS_NOTE = `When the user runs shell commands, they appear as \`<shell_events>\` inside \`<query_context>\` on your next turn — use them to ground "fix this" / "what just happened" requests.`;

const CWD_DRIFT_NOTE = `\`<cwd>\` is the working directory your own tool calls run in: relative paths resolve against it, and it follows the user's shell \`cd\`, so it can change from one turn to the next. Always act on the latest \`<cwd>\`, not one from earlier in the conversation.`;

const PREFERENCES_NOTE = `Treat the user's commands as standing preferences: check them for recurring patterns and apply them proactively, without waiting to be asked.`;

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
  source: "user" | "agent" | "user-excluded";
  spillPath?: string;
}

export default function activate(ctx: ExtensionContext): void {
  const { bus } = ctx;
  // The agent shares the user's cwd only under the shell frontend (which installs
  // ctx.shell); other frontends — e.g. ashi — keep their own fixed cwd.
  const ownsAgentCwd = !!(ctx as { shell?: unknown }).shell;

  const exchanges: ShellExchange[] = [];
  let nextId = 1;
  let currentCwd = process.cwd();
  let agentShellActive = false;
  let nextUserExcluded = false;
  let lastSeq = 0;

  bus.on("shell:command-done", (e) => {
    const lines = e.output.split("\n");
    const s = getSettings();

    // Long outputs spill to a tempfile the agent can `read_file` instead of
    // carrying the full text in LLM context.
    let output = e.output;
    let spillPath: string | undefined;
    if (lines.length > s.shellTruncateThreshold) {
      const id = nextId;
      try {
        spillPath = spillOutput(id, e.output);
        output = buildSpillStub(lines, s.shellHeadLines, s.shellTailLines, spillPath);
      } catch {
        output = e.output;
        spillPath = undefined;
      }
    }

    const source: ShellExchange["source"] = agentShellActive
      ? "agent"
      : nextUserExcluded
        ? "user-excluded"
        : "user";
    if (nextUserExcluded) nextUserExcluded = false;

    exchanges.push({
      id: nextId++,
      timestamp: Date.now(),
      cwd: e.cwd,
      command: e.command,
      output,
      exitCode: e.exitCode,
      outputLines: lines.length,
      outputBytes: e.output.length,
      source,
      spillPath,
    });
  });

  bus.on("shell:cwd-change", (e) => { currentCwd = e.cwd; });
  bus.on("shell:agent-exec-start", () => { agentShellActive = true; });
  bus.on("shell:agent-exec-done", () => { agentShellActive = false; });
  bus.on("shell:user-exec-exclude-next", () => { nextUserExcluded = true; });

  if (ownsAgentCwd) ctx.advise("cwd", () => currentCwd);

  // Advise the core handler directly: this loads before the agent host
  // attaches `ctx.agent`, so the sugar isn't available yet.
  ctx.advise("query-context:build", (next) => {
    const base = next() as string;
    const fresh = exchanges.filter((ex) => ex.id > lastSeq && ex.source === "user");
    let shellEvents = "";
    if (fresh.length > 0) {
      lastSeq = exchanges[exchanges.length - 1]!.id;
      const text = fresh.map(formatExchangeTruncated).filter(Boolean).join("\n");
      if (text) shellEvents = `<shell_events>\n${text}\n</shell_events>`;
    }
    const part = ownsAgentCwd
      ? [`<cwd>${currentCwd}</cwd>`, shellEvents].filter(Boolean).join("\n")
      : shellEvents;
    return [base, part].filter(Boolean).join("\n\n");
  });

  bus.onPipe("agent:instructions", (acc) => {
    const text = [SHELL_EVENTS_NOTE, ownsAgentCwd ? CWD_DRIFT_NOTE : "", PREFERENCES_NOTE]
      .filter(Boolean).join("\n\n");
    acc.instructions.push({ name: "shell-events", text });
    return acc;
  });

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
