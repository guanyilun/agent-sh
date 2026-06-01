import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type { AgentShMessage } from "./llm-client.js";
export type { AgentShMessage } from "./llm-client.js";

export interface SessionHeaderEntry {
  type: "session";
  id: string;
  parentId: null;
  timestamp: number;
  cwd: string;
  version: 1;
}

export interface MessageEntry {
  type: "message";
  id: string;
  parentId: string;
  timestamp: number;
  message: AgentShMessage;
}

export interface CompactionEntry {
  type: "compaction";
  id: string;
  parentId: string;
  timestamp: number;
  firstKeptId: string;
  tokensBefore: number;
  summary?: string;
}

/** Omitted from buildMessages — the agent already saw it via <shell_events>. */
export interface ShellExchangeEntry {
  type: "shell-exchange";
  id: string;
  parentId: string;
  timestamp: number;
  command: string;
  output: string;
  exitCode: number | null;
  cwd?: string;
  private?: boolean;
}

export type SessionEntry =
  | SessionHeaderEntry
  | MessageEntry
  | CompactionEntry
  | ShellExchangeEntry;

export function newEntryId(): string {
  return crypto.randomBytes(4).toString("hex");
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((p) => {
      if (typeof p === "string") return p;
      const part = p as { text?: string; content?: string };
      return part?.text ?? part?.content ?? "";
    }).join(" ");
  }
  return "";
}

function snippet(text: string, max: number): string {
  const cleaned = String(text ?? "").replace(/\s+/g, " ").trim();
  if (cleaned.length <= max) return cleaned || "(empty)";
  return cleaned.slice(0, max) + "…";
}

export function summarizeMessage(m: AgentShMessage): string {
  const role = m.role ?? "?";
  if (role === "assistant") {
    const tc = (m as { tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> }).tool_calls;
    if (Array.isArray(tc) && tc.length > 0) {
      const tools = tc.map((t) => {
        const name = t.function?.name ?? "tool";
        const args = t.function?.arguments;
        return args ? `${name}(${snippet(args, 200)})` : name;
      }).join(", ");
      const text = extractText(m.content);
      const prefix = text ? `${snippet(text, 400)} → ` : "";
      return `assistant: ${prefix}called ${tools}`;
    }
  }
  if (role === "tool") {
    const text = typeof m.content === "string" ? m.content : extractText(m.content);
    const isErr = /^error\b|: error\b/i.test(text.slice(0, 200));
    return `tool result: ${snippet(text, isErr ? 1000 : 400)}`;
  }
  if (role === "user") {
    return `user: ${snippet(extractText(m.content), 1000)}`;
  }
  return `${role}: ${snippet(extractText(m.content), 500)}`;
}

/** For displayed user text. Loops because both wrappers can stack at the head. */
export function stripContextWrappers(content: string): string {
  let out = content;
  for (;;) {
    const next = out.replace(/^\s*<(query_context|dynamic_context)>[\s\S]*?<\/\1>\s*/, "");
    if (next === out) return out;
    out = next;
  }
}

export function renderEvictedSummary(evicted: AgentShMessage[]): string {
  const lines = evicted.map((m) => `- ${summarizeMessage(m)}`);
  return `${lines.length} message(s) elided\n${lines.join("\n")}`;
}

export class SessionStore {
  private entriesPath: string;
  private leafPath: string;
  private entries = new Map<string, SessionEntry>();
  private rootId = "";
  private activeLeaf = "";
  private pendingHeader: SessionHeaderEntry | null = null;
  readonly id: string;

  constructor(filePath: string, opts?: { create?: { cwd: string; sessionId: string } }) {
    this.entriesPath = filePath;
    this.leafPath = filePath + ".leaf";
    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    if (opts?.create) {
      this.id = opts.create.sessionId;
      const header: SessionHeaderEntry = {
        type: "session",
        id: opts.create.sessionId,
        parentId: null,
        timestamp: Date.now(),
        cwd: opts.create.cwd,
        version: 1,
      };
      this.entries.set(header.id, header);
      this.rootId = header.id;
      this.activeLeaf = header.id;
      this.pendingHeader = header;
    } else {
      this.id = "";
      this.load();
      if (!this.rootId) throw new Error(`session file lacks a session header: ${filePath}`);
      this.id = this.rootId;
    }
  }

  /** Deferred so an opened-but-unused session leaves no files on disk. */
  private flushHeader(): void {
    if (!this.pendingHeader) return;
    const headerLine = JSON.stringify(this.pendingHeader) + "\n";
    this.pendingHeader = null;
    fs.writeFileSync(this.entriesPath, headerLine);
    this.persistLeaf();
  }

  getActiveLeaf(): string { return this.activeLeaf; }
  setActiveLeaf(id: string): void {
    if (!this.entries.has(id)) throw new Error(`unknown entry: ${id}`);
    this.activeLeaf = id;
    this.persistLeaf();
  }
  getRootId(): string { return this.rootId; }
  getEntry(id: string): SessionEntry | undefined { return this.entries.get(id); }
  getAllEntries(): SessionEntry[] { return [...this.entries.values()]; }

  async appendMessages(messages: AgentShMessage[]): Promise<string[]> {
    if (messages.length === 0) return [];
    this.flushHeader();
    let parent = this.activeLeaf;
    const lines: string[] = [];
    const newIds: string[] = [];
    for (const m of messages) {
      const e: MessageEntry = {
        type: "message",
        id: newEntryId(),
        parentId: parent,
        timestamp: Date.now(),
        message: m,
      };
      this.entries.set(e.id, e);
      lines.push(JSON.stringify(e));
      newIds.push(e.id);
      parent = e.id;
    }
    this.activeLeaf = parent;
    await fsp.appendFile(this.entriesPath, lines.join("\n") + "\n");
    this.persistLeaf();
    return newIds;
  }

  async appendShellExchange(e: {
    command: string;
    output: string;
    exitCode: number | null;
    cwd?: string;
    private?: boolean;
  }): Promise<string> {
    this.flushHeader();
    const entry: ShellExchangeEntry = {
      type: "shell-exchange",
      id: newEntryId(),
      parentId: this.activeLeaf,
      timestamp: Date.now(),
      command: e.command,
      output: e.output,
      exitCode: e.exitCode,
      ...(e.cwd !== undefined ? { cwd: e.cwd } : {}),
      ...(e.private ? { private: true } : {}),
    };
    this.entries.set(entry.id, entry);
    this.activeLeaf = entry.id;
    await fsp.appendFile(this.entriesPath, JSON.stringify(entry) + "\n");
    this.persistLeaf();
    return entry.id;
  }

  async appendCompaction(firstKeptId: string, tokensBefore: number, summary?: string): Promise<string> {
    if (!this.entries.has(firstKeptId)) throw new Error(`firstKeptId unknown: ${firstKeptId}`);
    this.flushHeader();
    const e: CompactionEntry = {
      type: "compaction",
      id: newEntryId(),
      parentId: this.activeLeaf,
      timestamp: Date.now(),
      firstKeptId,
      tokensBefore,
      ...(summary !== undefined ? { summary } : {}),
    };
    this.entries.set(e.id, e);
    this.activeLeaf = e.id;
    await fsp.appendFile(this.entriesPath, JSON.stringify(e) + "\n");
    this.persistLeaf();
    return e.id;
  }

  /** Returns oldest-first. */
  getBranch(leafId: string = this.activeLeaf): SessionEntry[] {
    const out: SessionEntry[] = [];
    const seen = new Set<string>();
    let cur: string | null = leafId;
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const e = this.entries.get(cur);
      if (!e) break;
      out.push(e);
      cur = e.parentId;
    }
    return out.reverse();
  }

  /** Latest compaction on the branch replaces the evicted prefix with
   *  its stored summary, or a rendered one if no summary was stored. */
  buildMessages(leafId: string = this.activeLeaf): AgentShMessage[] {
    return this.buildBranchWithIds(leafId).messages;
  }

  /** Parallel entryIds array — null for the synthetic compaction-summary
   *  slot — so callers can map message indices back to on-disk ids. */
  buildBranchWithIds(leafId: string = this.activeLeaf): { messages: AgentShMessage[]; entryIds: (string | null)[] } {
    const branch = this.getBranch(leafId);
    let compactionIdx = -1;
    for (let i = branch.length - 1; i >= 0; i--) {
      if (branch[i]!.type === "compaction") { compactionIdx = i; break; }
    }
    const messages: AgentShMessage[] = [];
    const entryIds: (string | null)[] = [];
    let startIdx = 0;
    if (compactionIdx >= 0) {
      const c = branch[compactionIdx] as CompactionEntry;
      const firstKeptIdx = branch.findIndex((e) => e.id === c.firstKeptId);
      startIdx = firstKeptIdx >= 0 ? firstKeptIdx : 0;
      const summary = c.summary ?? renderEvictedSummary(
        branch.slice(0, startIdx)
          .filter((e): e is MessageEntry => e.type === "message")
          .map((e) => e.message),
      );
      messages.push({ role: "user", content: `[Compacted conversation summary]\n${summary}` });
      entryIds.push(null);
    }
    for (let i = startIdx; i < branch.length; i++) {
      const e = branch[i]!;
      if (e.type === "message") {
        messages.push(e.message);
        entryIds.push(e.id);
      }
    }
    return { messages, entryIds };
  }

  getPreview(): string {
    for (const e of this.entries.values()) {
      if (e.type === "message" && e.message.role === "user") {
        const raw = typeof e.message.content === "string" ? e.message.content : "";
        const txt = stripContextWrappers(raw).replace(/\s+/g, " ").trim();
        if (txt) return txt.slice(0, 80);
      }
    }
    return "(empty)";
  }

  private load(): void {
    let raw: string;
    try { raw = fs.readFileSync(this.entriesPath, "utf-8"); }
    catch { return; }
    for (const line of raw.split("\n")) {
      if (!line) continue;
      try {
        const e = JSON.parse(line) as SessionEntry;
        if (!e.id) continue;
        this.entries.set(e.id, e);
        if (e.type === "session") this.rootId = e.id;
      } catch { /* skip malformed */ }
    }
    try {
      this.activeLeaf = fs.readFileSync(this.leafPath, "utf-8").trim();
      if (!this.entries.has(this.activeLeaf)) this.activeLeaf = this.rootId;
    } catch { this.activeLeaf = this.lastEntryId(); }
  }

  private lastEntryId(): string {
    let lastId = this.rootId;
    for (const e of this.entries.values()) lastId = e.id;
    return lastId;
  }

  private persistLeaf(): void {
    if (this.pendingHeader) return;
    fs.writeFileSync(this.leafPath, this.activeLeaf);
  }
}
