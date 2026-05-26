import type { Store, Entry } from "../../store.js";
import type { AgentShMessage } from "../../llm-client.js";
import { formatEntryLine } from "../../entry-format.js";
import { RECALL_CACHE_KIND } from "./constants.js";
import { readSummaryLines } from "./strategy.js";

interface SummaryPayload {
  sum: string;
  body?: string;
  iid?: string;
  tool?: string;
  why?: string;
}

interface RecallCachePayload {
  fullMessage: AgentShMessage;
}

function turnToText(msgs: AgentShMessage[]): string {
  const lines: string[] = [];
  for (const m of msgs) {
    if (m.role === "user") {
      lines.push(`[user] ${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`);
    } else if (m.role === "assistant") {
      if (typeof m.content === "string" && m.content) lines.push(`[assistant] ${m.content}`);
      if ("tool_calls" in m && m.tool_calls) {
        for (const tc of m.tool_calls) {
          if ("function" in tc) lines.push(`[tool_call] ${tc.function.name}(${tc.function.arguments})`);
        }
      }
    } else if (m.role === "tool") {
      lines.push(`[tool] ${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`);
    } else {
      lines.push(`[${m.role}] ${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`);
    }
  }
  return lines.join("\n");
}

function firstMatchExcerpt(text: string, regex: RegExp): string | null {
  const idx = text.search(regex);
  if (idx === -1) return null;
  const lineStart = text.lastIndexOf("\n", idx) + 1;
  const lineEnd = text.indexOf("\n", idx);
  const line = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd).trim();
  if (line.length > 120) {
    const matchInLine = idx - lineStart;
    const start = Math.max(0, matchInLine - 40);
    const end = Math.min(line.length, matchInLine + 80);
    return (start > 0 ? "…" : "") + line.slice(start, end) + (end < line.length ? "…" : "");
  }
  return line;
}

function buildSearchRegex(query: string): RegExp {
  try {
    return new RegExp(query, "i");
  } catch {
    const words = query.split(/\s+/).filter((w) => w.length > 0);
    const escaped = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const lookaheads = escaped.map((w) => `(?=.*${w})`).join("");
    return new RegExp(lookaheads, "i");
  }
}

/** Cache entries are ephemeral, so this only resolves for the
 *  current process. */
async function findCacheChild(store: Store, parentId: string): Promise<RecallCachePayload | null> {
  const recent = await store.readRecent();
  for (let i = recent.length - 1; i >= 0; i--) {
    const e = recent[i]!;
    if (e.kind === RECALL_CACHE_KIND && e.parentId === parentId) {
      return e.payload as unknown as RecallCachePayload;
    }
  }
  return null;
}

export async function recallSearch(store: Store, query: string): Promise<string> {
  if (!query.trim()) return "No query provided.";
  const regex = buildSearchRegex(query);
  const hits: string[] = [];
  const seenParents = new Set<string>();

  const matches = await store.search(query);
  for (const m of matches) {
    // Cache hits surface via their parent summary; summary hits are their own parent.
    let parentEntry: Entry | null = null;
    if (m.entry.kind === RECALL_CACHE_KIND) {
      if (!m.entry.parentId) continue;
      parentEntry = await store.findById(m.entry.parentId);
    } else {
      parentEntry = m.entry;
    }
    if (!parentEntry || seenParents.has(parentEntry.id)) continue;
    seenParents.add(parentEntry.id);

    const cache = await findCacheChild(store, parentEntry.id);
    const excerptSource = cache
      ? turnToText([cache.fullMessage])
      : (parentEntry.payload as unknown as SummaryPayload).body ?? "";
    const excerpt = excerptSource ? firstMatchExcerpt(excerptSource, regex) : null;
    const header = formatEntryLine(parentEntry);
    hits.push(excerpt ? `${header}\n  ${excerpt}` : header);
  }

  if (hits.length === 0) return `No results found for "${query}".`;
  const total = hits.length;
  const summary = `Found ${total} match${total === 1 ? "" : "es"} for "${query}"`;
  return `${summary}\n\n${hits.slice(0, 30).join("\n\n")}`;
}

export async function recallExpand(store: Store, id: string): Promise<string> {
  const entry = await store.findById(id);
  if (!entry) return `Entry ${id}: not found.`;
  if (entry.kind === RECALL_CACHE_KIND) return `Entry ${id}: not expandable.`;
  const header = formatEntryLine(entry);

  const cache = await findCacheChild(store, id);
  if (cache) return `${header}\n\n${turnToText([cache.fullMessage])}`;

  const body = (entry.payload as unknown as SummaryPayload).body;
  if (body) return `${header}\n\n${body}`;
  return `${header}\n\n(no expanded content available — recall cache may have been cleared)`;
}

export async function recallBrowse(store: Store, limit = 25): Promise<string> {
  const lines = await readSummaryLines(store, limit);
  if (lines.length === 0) return "No conversation history.";
  return ["Recent summary entries:", ...lines.map((l) => `  ${l}`)].join("\n");
}
