/**
 * rtk-proxy — transparently rewrites bash commands to `rtk <command>`
 * so the LLM sees rtk's compressed output (60-90% token reduction on
 * common dev commands: git, cargo, npm, jest, pytest, ls, grep, …).
 *
 * Demonstrates: `ctx.advise("tool:execute", …)` wrapping + line-buffered
 * stream scrub.
 *
 * Compound commands like `cd X && pytest` rewrite the last segment only.
 * Pipes, subshells, and redirects are skipped (unsafe to wrap).
 *
 * Requires the `rtk` binary on PATH (https://github.com/rtk-ai/rtk).
 *
 * Settings (~/.agent-sh/settings.json):
 *   { "rtk-proxy": { "enabled": true, "ultraCompact": false,
 *                    "extraPrefixes": [], "excludePrefixes": [] } }
 *
 * Usage:
 *   ash -e ./examples/extensions/rtk-proxy.ts
 *   cp examples/extensions/rtk-proxy.ts ~/.agent-sh/extensions/
 */
import { execSync } from "node:child_process";
import type { ExtensionContext } from "agent-sh/types";

const DEFAULT_PREFIXES = new Set([
  "git", "gh",
  "ls", "tree", "find", "grep", "rg", "cat",
  "cargo", "npm", "pnpm", "yarn",
  "jest", "vitest", "pytest", "playwright",
  "go", "ruff", "tsc", "eslint", "prettier", "biome",
  "docker", "kubectl",
  "aws",
  "pip", "bundle", "rake", "rspec", "rubocop",
  "golangci-lint", "next",
  "prisma",
]);

// Pipes, subshells, redirections — unsafe to wrap. Compound operators
// (&&, ||, ;) are handled by splitting and rewriting only the last segment.
const UNSAFE_SEGMENT_RE = /[|`()$><]/;

function firstToken(cmd: string): string {
  const m = cmd.trimStart().match(/^(\S+)/);
  return m ? m[1] : "";
}

// Caveat: textual split, no quoting awareness. A literal `&&` inside a
// quoted argument will split there. Acceptable today because no current
// prefix-token command takes args containing `&&`/`||`/`;`. If that
// changes, switch to a proper shell tokenizer.
function splitLastSegment(cmd: string): [string, string, string] | null {
  const match = cmd.match(/^(.*)(&&|\|\||;)\s*(\S.*)$/s);
  if (!match) return null;
  return [match[1].trimEnd(), match[2], match[3]];
}

function rewriteForRtk(cmd: string, prefixes: Set<string>, flag: string): string | null {
  const tok = firstToken(cmd);
  if (!tok || tok === "rtk") return null;
  // Escape hatch: `command foo` forces raw passthrough.
  if (tok === "command") return null;

  const parts = splitLastSegment(cmd);
  if (parts) {
    const [prefix, sep, lastSeg] = parts;
    if (UNSAFE_SEGMENT_RE.test(lastSeg)) return null;
    if (!prefixes.has(firstToken(lastSeg))) return null;
    return `${prefix} ${sep} RTK_TELEMETRY_DISABLED=1 rtk ${flag}${lastSeg}`;
  }

  if (UNSAFE_SEGMENT_RE.test(cmd)) return null;
  if (!prefixes.has(tok)) return null;
  return `RTK_TELEMETRY_DISABLED=1 rtk ${flag}${cmd}`;
}

export default function activate(ctx: ExtensionContext) {
  const config = ctx.getExtensionSettings("rtk-proxy", {
    enabled: true,
    ultraCompact: false,
    extraPrefixes: [] as string[],
    excludePrefixes: [] as string[],
  });
  if (!config.enabled) return;

  try {
    execSync("command -v rtk", { stdio: "ignore" });
  } catch {
    ctx.bus.emit("ui:info", {
      message: "rtk-proxy: `rtk` binary not on PATH — extension inactive.",
    });
    return;
  }

  const prefixes = new Set([...DEFAULT_PREFIXES, ...config.extraPrefixes]);
  for (const p of config.excludePrefixes) prefixes.delete(p);
  const flag = config.ultraCompact ? "--ultra-compact " : "";

  ctx.registerInstruction("rtk-proxy",
    "The rtk-proxy extension transparently rewrites bash commands like " +
    "`git status`, `cargo test`, `pytest` to their rtk-compressed equivalents " +
    "before execution. Output will be condensed (errors/failures first, " +
    "boilerplate stripped). For raw unfiltered output, prefix with `command ` " +
    "(e.g. `command git log`) or pipe (`git log | cat`) — both skip the rewrite.",
  );

  // rtk prints a nag line when it sees ~/.claude/ but no hook. We're doing
  // the rewrite ourselves, so strip the advisory from streamed + final output.
  const NAG_RE = /^\[(?:rtk|warn)\][^\n]*No hook installed[^\n]*\n?/gm;
  const scrub = (s: string) => s.replace(NAG_RE, "");

  ctx.advise("tool:execute", async (next, toolCtx) => {
    if (toolCtx.name !== "bash") return next(toolCtx);
    const command = toolCtx.args?.command;
    if (typeof command !== "string") return next(toolCtx);

    const rewritten = rewriteForRtk(command, prefixes, flag);
    if (rewritten === null) return next(toolCtx);

    toolCtx.args = { ...toolCtx.args, command: rewritten };

    // Line-buffer the stream so the nag-line scrub works across chunks.
    const origOnChunk = toolCtx.onChunk;
    if (origOnChunk) {
      let buf = "";
      toolCtx.onChunk = (chunk: string) => {
        buf += chunk;
        const lastNl = buf.lastIndexOf("\n");
        if (lastNl !== -1) {
          origOnChunk(scrub(buf.slice(0, lastNl + 1)));
          buf = buf.slice(lastNl + 1);
        }
      };
      const result = await next(toolCtx);
      if (buf) origOnChunk(scrub(buf));
      return { ...result, content: scrub(result.content) };
    }
    return next(toolCtx);
  });

  ctx.bus.emit("ui:info", {
    message: `rtk-proxy active (${prefixes.size} command prefixes).`,
  });
}
