import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverProjectSkills, type Skill } from "./skills.js";

/**
 * Format skills for inline display in prompt.
 * Shows name, description, and file path so the model can decide immediately
 * whether to load a skill — no extra round-trip needed.
 */
export function formatSkillsBlock(skills: Skill[]): string {
  if (skills.length === 0) return "";
  return "# Available Skills\n\n"
    + "Load a skill's full content with read_file on its file path when needed.\n\n"
    + skills.map(s => `- **${s.name}**: ${s.description}\n  Path: ${s.filePath}`).join("\n\n");
}

import { CONFIG_DIR } from "../core/settings.js";
const GLOBAL_AGENTS_MD = path.join(CONFIG_DIR, "AGENTS.md");

// ── File caches ─────────────────────────────────────────────────────
// Convention files (CLAUDE.md/AGENT.md) are walked synchronously from
// CWD to root on every query. In practice they almost never change,
// so a short TTL cache keyed by CWD avoids redundant filesystem walks.
// The 5-second TTL is short enough to pick up edits quickly but long
// enough to eliminate repeated walks within a multi-tool agent loop.

const CACHE_TTL_MS = 5_000;

/** TTL cache for convention files, keyed by resolved CWD. */
let conventionCache: { cwd: string; result: string[]; expiry: number } | null = null;

/** TTL cache for global AGENTS.md — changes extremely rarely. */
let agentsMdCache: { result: string | null; expiry: number } | null = null;

export function loadGlobalAgentsMd(): string | null {
  const now = Date.now();
  if (agentsMdCache && now < agentsMdCache.expiry) {
    return agentsMdCache.result;
  }
  try {
    const content = fs.readFileSync(GLOBAL_AGENTS_MD, "utf-8").trim();
    const result = content || null;
    agentsMdCache = { result, expiry: now + CACHE_TTL_MS };
    return result;
  } catch {
    agentsMdCache = { result: null, expiry: now + CACHE_TTL_MS };
    return null;
  }
}

/** Resolve the absolute path to agent-sh's own docs directory. */
const CODE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../",
);

/** File names to scan for project conventions (checked in order). */
const CONVENTION_FILES = ["CLAUDE.md", "AGENT.md"];

/**
 * Scan from `dir` upward for project convention files.
 * Returns contents ordered root-first (general → specific).
 * Results are cached for CACHE_TTL_MS, keyed by resolved directory.
 */
function loadConventionFiles(dir: string): string[] {
  const cwd = path.resolve(dir);
  const now = Date.now();

  if (conventionCache && conventionCache.cwd === cwd && now < conventionCache.expiry) {
    return conventionCache.result;
  }

  const files: { path: string; content: string }[] = [];
  let current = cwd;

  while (true) {
    for (const name of CONVENTION_FILES) {
      const candidate = path.join(current, name);
      try {
        const content = fs.readFileSync(candidate, "utf-8").trim();
        if (content) {
          files.push({ path: candidate, content });
          break;
        }
      } catch {
        // File doesn't exist
      }
    }

    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  files.reverse();
  const result = files.map(f => `<!-- ${f.path} -->\n${f.content}`);
  conventionCache = { cwd, result, expiry: now + CACHE_TTL_MS };
  return result;
}

/**
 * Static system prompt — identical across all queries, cacheable.
 * Contains only identity and behavioral instructions.
 */
export const STATIC_SYSTEM_PROMPT = `You are ash, an AI coding assistant running inside agent-sh — a composable agent runtime with a small core and everything else, including the shell integration, layered on as extensions.

You may be paired with a terminal shell that shares the user's CWD, environment, and history — in that mode you can read shell events and act on the user's session. Otherwise you may be embedded as a library, exposed over a bridge protocol, or running headless, with no shell available; in those modes you operate purely through your registered tools.

agent-sh source and documentation live at ${CODE_DIR}. Read them when you need to understand how the runtime works, or when the user asks how to modify or extend it:
- ${path.join(CODE_DIR, "docs")} — start with README.md; architecture.md and extensions.md cover the kernel boundary and extension API
- ${path.join(CODE_DIR, "src")} — kernel in src/core, default backend in src/agent, shell host in src/shell, built-in extensions in src/extensions
- ${path.join(CODE_DIR, "examples/extensions")} — reference extensions to study or copy when adding functionality

# Tool Decision Guide
bash, read_file, grep, glob, ls, edit_file, write_file::
Use these to investigate, search, read, and modify files. Output is returned
to you for reasoning — the user doesn't see it directly.

Extensions may register additional tools — follow their instructions.

# Tool Usage Guidelines
- Use read_file before editing a file you haven't seen
- Prefer edit_file over write_file for modifying existing files
- Use grep/glob to find files before reading them
- Keep bash commands focused; avoid long-running blocking commands
- Always check command exit codes for errors

# Context Envelopes
- \`<query_context>\` (contains \`<cwd>\` always, and \`<shell_events>\` when there were user shell commands since the last turn): the user's situation when they sent this turn — \`<cwd>\` anchors where they are right now, \`<shell_events>\` grounds "fix this" / "what just happened" requests. Trust the most recent \`<cwd>\` over any cwd referenced in earlier history.
- \`<dynamic_context>\`: current system state — in-flight work, mode markers, warnings.
\`<dynamic_context>\` may be absent on any turn.

# Preference Learning

Treat the user's past commands as standing preferences. Before acting, check shell history
and conversation context for recurring patterns — apply them proactively and do not wait to
be reminded.`;

/**
 * CWD-scoped static context: project conventions (CLAUDE.md / AGENT.md)
 * and discovered skills. Stable for a given cwd — callers should cache
 * on cwd identity rather than rebuilding per LLM iteration.
 */
export function buildStaticByCwd(cwd: string): string {
  const sections: string[] = [];

  const conventions = loadConventionFiles(cwd);
  if (conventions.length > 0) {
    sections.push("# Project Conventions\n\n" + conventions.join("\n\n"));
  }

  const projectSkills = discoverProjectSkills(cwd);
  const skillsBlock = formatSkillsBlock(projectSkills);
  if (skillsBlock) {
    sections.push(skillsBlock);
  }

  return sections.join("\n\n");
}
