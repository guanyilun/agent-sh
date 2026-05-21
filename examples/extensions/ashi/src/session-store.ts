import * as fs from "node:fs";
import * as crypto from "node:crypto";
import { FileStore, type Entry } from "agent-sh/core";

export interface ToolCall {
  id?: string;
  function?: { name: string; arguments?: string };
}

export interface AgentMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: unknown;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
  meta?: Record<string, unknown>;
}

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
  message: AgentMessage;
}

export interface CompactionEntry {
  type: "compaction";
  id: string;
  parentId: string;
  timestamp: number;
  summary: string;
  firstKeptId: string;
  tokensBefore: number;
}

export type SessionEntry = SessionHeaderEntry | MessageEntry | CompactionEntry;

export interface SessionMeta {
  name?: string;
  createdAt: number;
}

export function newEntryId(): string {
  return crypto.randomBytes(4).toString("hex");
}

function toSessionEntry(e: Entry): SessionEntry {
  const p = e.payload as Record<string, unknown>;
  if (e.kind === "session") {
    return {
      type: "session", id: e.id, parentId: null, timestamp: e.ts,
      cwd: p.cwd as string, version: 1,
    };
  }
  if (e.kind === "compaction") {
    return {
      type: "compaction", id: e.id, parentId: e.parentId!, timestamp: e.ts,
      summary: p.summary as string,
      firstKeptId: p.firstKeptId as string,
      tokensBefore: p.tokensBefore as number,
    };
  }
  return {
    type: "message", id: e.id, parentId: e.parentId!, timestamp: e.ts,
    message: p.message as AgentMessage,
  };
}

/** One FileStore per session + a `.meta` sidecar for display name
 *  and createdAt. */
export class SessionStore {
  private store: FileStore;
  private metaPath: string;
  private meta: SessionMeta;
  readonly id: string;

  constructor(filePath: string, opts?: { create?: { cwd: string; sessionId: string } }) {
    this.metaPath = filePath + ".meta";
    if (opts?.create) {
      const headerEntry: Entry = {
        id: opts.create.sessionId,
        ts: Date.now(),
        kind: "session",
        payload: { cwd: opts.create.cwd, version: 1 },
      };
      this.store = new FileStore({ filePath, root: headerEntry });
      this.id = opts.create.sessionId;
      this.meta = { createdAt: headerEntry.ts };
      this.persistMeta();
    } else {
      this.store = new FileStore({ filePath });
      const rootId = this.store.getRootId();
      if (!rootId) throw new Error(`session file lacks a session header: ${filePath}`);
      this.id = rootId;
      try {
        this.meta = JSON.parse(fs.readFileSync(this.metaPath, "utf-8")) as SessionMeta;
      } catch { this.meta = { createdAt: 0 }; }
    }
  }

  getActiveLeaf(): string { return this.store.getLeaf(); }
  setActiveLeaf(id: string): void { this.store.setLeaf(id); }
  getRootId(): string { return this.id; }

  async getEntry(id: string): Promise<SessionEntry | undefined> {
    const e = await this.store.findById(id);
    return e ? toSessionEntry(e) : undefined;
  }

  async getAllEntries(): Promise<SessionEntry[]> {
    const entries = await this.store.readRecent();
    return entries.map(toSessionEntry);
  }

  entryCount(): number { return this.store.size(); }

  getMeta(): SessionMeta { return { ...this.meta }; }
  setName(name: string): void {
    this.meta.name = name;
    this.persistMeta();
  }

  /** Append messages as a chain starting from the active leaf.
   *  Returns the new ids in order. */
  async appendMessages(messages: AgentMessage[]): Promise<string[]> {
    if (messages.length === 0) return [];
    let parent = this.store.getLeaf();
    const entries: Entry[] = [];
    const newIds: string[] = [];
    for (const m of messages) {
      const id = newEntryId();
      entries.push({
        id, parentId: parent, ts: Date.now(),
        kind: "message", payload: { message: m },
      });
      newIds.push(id);
      parent = id;
    }
    await this.store.append(entries);
    this.store.setLeaf(parent);
    return newIds;
  }

  async appendCompaction(summary: string, firstKeptId: string, tokensBefore: number): Promise<string> {
    if (!(await this.store.findById(firstKeptId))) {
      throw new Error(`firstKeptId unknown: ${firstKeptId}`);
    }
    const id = newEntryId();
    const entry: Entry = {
      id, parentId: this.store.getLeaf(), ts: Date.now(),
      kind: "compaction",
      payload: { summary, firstKeptId, tokensBefore },
    };
    await this.store.append([entry]);
    this.store.setLeaf(id);
    return id;
  }

  async getBranch(leafId: string = this.store.getLeaf()): Promise<SessionEntry[]> {
    const branch = await this.store.getBranch(leafId);
    return branch.map(toSessionEntry);
  }

  /** Materialize messages for `leafId`, honoring the latest compaction
   *  on the branch (synthetic summary + kept tail). */
  async buildMessages(leafId: string = this.store.getLeaf()): Promise<AgentMessage[]> {
    const branch = await this.getBranch(leafId);
    let compactionIdx = -1;
    for (let i = branch.length - 1; i >= 0; i--) {
      if (branch[i]!.type === "compaction") { compactionIdx = i; break; }
    }
    if (compactionIdx < 0) {
      return branch
        .filter((e): e is MessageEntry => e.type === "message")
        .map((e) => e.message);
    }
    const c = branch[compactionIdx] as CompactionEntry;
    const firstKeptIdx = branch.findIndex((e) => e.id === c.firstKeptId);
    const keepFrom = firstKeptIdx >= 0 ? firstKeptIdx : 0;
    const out: AgentMessage[] = [{
      role: "user",
      content: `[Compacted conversation summary]\n${c.summary}`,
    }];
    for (let i = keepFrom; i < branch.length; i++) {
      const e = branch[i]!;
      if (e.type === "message") out.push(e.message);
    }
    return out;
  }

  async getPreview(): Promise<string> {
    const entries = await this.store.readRecent();
    for (const e of entries) {
      if (e.kind !== "message") continue;
      const msg = (e.payload as { message: AgentMessage }).message;
      if (msg.role !== "user") continue;
      const txt = typeof msg.content === "string" ? msg.content : "";
      if (txt) return txt.slice(0, 80);
    }
    return "(empty)";
  }

  private persistMeta(): void {
    fs.writeFileSync(this.metaPath, JSON.stringify(this.meta));
  }
}
