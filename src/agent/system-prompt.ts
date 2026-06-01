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
    + "Load a skill's full content from its file path with your file-reading tool when needed.\n\n"
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
 * Identity — paragraph one of the system prompt. Surface-agnostic, cacheable.
 */
export const STATIC_IDENTITY = `You are ash, an AI coding assistant running inside agent-sh — a composable agent runtime with a small core and everything else, including the frontend you're attached to, layered on as extensions.`;

/**
 * The rest of the static prompt — code map, tool guidance, envelope contract.
 * Follows the frontend surface description in the assembled prompt.
 */
export const STATIC_GUIDE = `agent-sh source and documentation live at ${CODE_DIR}. Read them when you need to understand how the runtime works, or when the user asks how to modify or extend it:
- ${path.join(CODE_DIR, "docs")} — start with README.md; architecture.md and extensions.md cover the kernel boundary and extension API
- ${path.join(CODE_DIR, "src")} — kernel in src/core, default backend in src/agent, shell host in src/shell, built-in extensions in src/extensions
- ${path.join(CODE_DIR, "examples/extensions")} — reference extensions to study or copy when adding functionality

# Tools

Use your registered tools to investigate, search, read, and modify files.
Each tool's description tells you when and how to use it; follow that
guidance rather than assuming a particular tool exists. Tool output is
returned to you for reasoning — the user doesn't see it directly.

# Context Envelopes

A turn may be preceded by either of two wrappers:
- \`<query_context>\`: the user's situation when they sent this turn — the frontend and extensions inject what grounds the request here. Trust the most recent values over anything referenced earlier in history.
- \`<dynamic_context>\`: current system state — in-flight work, mode markers, warnings.

Either may be absent on any turn.`;

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
