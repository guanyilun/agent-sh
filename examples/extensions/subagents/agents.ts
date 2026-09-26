import * as fs from "node:fs";
import * as path from "node:path";

export interface AgentDef {
  name: string;
  description: string;
  systemPrompt: string;
  /** Undefined means every parent tool except spawn_agent. */
  tools?: string[];
  model?: string;
  thinking?: string;
  maxIterations?: number;
  inheritContext: boolean;
  source: string;
}

// pi tool names, so pi-subagents agent files work unchanged.
const TOOL_ALIASES: Record<string, string> = {
  read: "read_file",
  write: "write_file",
  edit: "edit_file",
  find: "glob",
};

export function parseAgent(content: string, source: string): AgentDef | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return null;
  const meta: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon <= 0 || /^\s/.test(line)) continue;
    meta[line.slice(0, colon).trim()] = line.slice(colon + 1).trim().replace(/^["']|["']$/g, "");
  }
  const name = meta.name || path.basename(source, ".md");
  if (!name) return null;
  const maxIterations = Number(meta.maxIterations);
  return {
    name,
    description: meta.description ?? "",
    systemPrompt: match[2]!.trim(),
    tools: meta.tools
      ? meta.tools.split(",").map(t => t.trim()).filter(Boolean).map(t => TOOL_ALIASES[t] ?? t)
      : undefined,
    model: meta.model || undefined,
    thinking: meta.thinking || undefined,
    maxIterations: Number.isFinite(maxIterations) && maxIterations > 0 ? maxIterations : undefined,
    inheritContext: meta.inheritContext === "true",
    source,
  };
}

export function discoverAgents(dirs: string[]): Map<string, AgentDef> {
  const agents = new Map<string, AgentDef>();
  for (const dir of dirs) {
    let entries: string[];
    try { entries = fs.readdirSync(dir); } catch { continue; }
    for (const file of entries.sort()) {
      if (!file.endsWith(".md")) continue;
      const source = path.join(dir, file);
      let def: AgentDef | null = null;
      try { def = parseAgent(fs.readFileSync(source, "utf8"), source); } catch {}
      if (def) agents.set(def.name, def);
    }
  }
  return agents;
}
