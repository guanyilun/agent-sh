import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type { NuclearEntry } from "agent-sh/core";
import { LeafTrackingTreeAdapter, type SessionTree } from "./leaf-tracking-tree-history.js";

export interface SessionMeta {
  createdAt: number;
  name?: string;
}

export interface SessionInfo {
  id: string;
  createdAt: number;
  name?: string;
  preview?: string;
  entryCount: number;
}

/** One tree per session, many sessions per cwd. Each launch creates a
 *  fresh session by default; users opt into resuming via /resume. */
export class MultiSessionTreeAdapter implements SessionTree {
  private rootDir: string;
  private current: LeafTrackingTreeAdapter;
  private currentId: string;

  constructor(rootDir: string) {
    this.rootDir = rootDir;
    fs.mkdirSync(rootDir, { recursive: true });
    this.currentId = newSessionId();
    this.current = new LeafTrackingTreeAdapter(this.sessionDir(this.currentId));
    writeMeta(this.sessionDir(this.currentId), { createdAt: Date.now() });
  }

  getCurrentId(): string { return this.currentId; }

  newSession(): string {
    const id = newSessionId();
    this.current = new LeafTrackingTreeAdapter(this.sessionDir(id));
    this.currentId = id;
    writeMeta(this.sessionDir(id), { createdAt: Date.now() });
    return id;
  }

  switchTo(id: string): void {
    const dir = this.sessionDir(id);
    if (!fs.existsSync(dir)) throw new Error(`session not found: ${id}`);
    this.current = new LeafTrackingTreeAdapter(dir);
    this.currentId = id;
  }

  setName(name: string): void {
    const dir = this.sessionDir(this.currentId);
    const meta = readMeta(dir);
    meta.name = name;
    writeMeta(dir, meta);
  }

  async listSessions(): Promise<SessionInfo[]> {
    let names: string[];
    try { names = fs.readdirSync(this.rootDir); } catch { return []; }
    const result: SessionInfo[] = [];
    for (const id of names) {
      const dir = path.join(this.rootDir, id);
      try {
        if (!fs.statSync(dir).isDirectory()) continue;
      } catch { continue; }
      const meta = readMeta(dir);
      let preview: string | undefined;
      let entryCount = 0;
      try {
        const adapter = new LeafTrackingTreeAdapter(dir);
        const tree = await adapter.getTree();
        entryCount = tree.length;
        const firstUser = tree.find((e) => e.kind === "user");
        preview = (firstUser ?? tree[0])?.sum;
      } catch { /* skip unreadable */ }
      result.push({ id, createdAt: meta.createdAt ?? 0, name: meta.name, preview, entryCount });
    }
    result.sort((a, b) => b.createdAt - a.createdAt);
    return result;
  }

  private sessionDir(id: string): string {
    return path.join(this.rootDir, id);
  }

  // ── SessionTree delegation ─────────────────────────────────
  append(entries: NuclearEntry[]): Promise<void> { return this.current.append(entries); }
  readRecent(max?: number): Promise<NuclearEntry[]> { return this.current.readRecent(max); }
  search(q: string): Promise<{ entry: NuclearEntry; line: string }[]> { return this.current.search(q); }
  findBySeq(seq: number): Promise<NuclearEntry | null> { return this.current.findBySeq(seq); }
  getBranch(seq: number): Promise<NuclearEntry[]> { return this.current.getBranch(seq); }
  getTree(): Promise<NuclearEntry[]> { return this.current.getTree(); }
  setLeaf(seq: number): void { this.current.setLeaf(seq); }
  getActiveLeaf(): number { return this.current.getActiveLeaf(); }
  saveSnapshot(leaf: number, messages: unknown[]): void { this.current.saveSnapshot(leaf, messages); }
  loadSnapshot(leaf: number): unknown[] | null { return this.current.loadSnapshot(leaf); }
  hasSnapshot(leaf: number): boolean { return this.current.hasSnapshot(leaf); }
}

function newSessionId(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const suffix = crypto.randomBytes(3).toString("hex");
  return `${ts}_${suffix}`;
}

function readMeta(dir: string): SessionMeta {
  try {
    const raw = fs.readFileSync(path.join(dir, "meta.json"), "utf-8");
    return JSON.parse(raw) as SessionMeta;
  } catch { return { createdAt: 0 }; }
}

function writeMeta(dir: string, meta: SessionMeta): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(meta));
}
