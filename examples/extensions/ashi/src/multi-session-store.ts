import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { SessionStore } from "./session-store.js";

export interface SessionInfo {
  id: string;
  filePath: string;
  createdAt: number;
  name?: string;
  preview: string;
  entryCount: number;
}

/** Many sessions per cwd. Each is one .jsonl file under `dir/`. Constructor
 *  always opens a fresh session; /resume callers can `openSession(id)` to
 *  swap the current store to a past session file. */
export class MultiSessionStore {
  private dir: string;
  private cwd: string;
  private currentStore: SessionStore;

  constructor(dir: string, cwd: string) {
    this.dir = dir;
    this.cwd = cwd;
    fs.mkdirSync(dir, { recursive: true });
    this.currentStore = this.createFreshSession();
  }

  current(): SessionStore { return this.currentStore; }

  newSession(): SessionStore {
    this.currentStore = this.createFreshSession();
    return this.currentStore;
  }

  openSession(id: string): SessionStore {
    const filePath = this.sessionFile(id);
    if (!fs.existsSync(filePath)) throw new Error(`session not found: ${id}`);
    this.currentStore = new SessionStore(filePath);
    return this.currentStore;
  }

  deleteSession(id: string): void {
    if (id === this.currentStore.id) throw new Error("cannot delete the active session");
    const filePath = this.sessionFile(id);
    for (const p of [filePath, filePath + ".leaf", filePath + ".meta"]) {
      try { fs.unlinkSync(p); } catch { /* missing siblings are fine */ }
    }
  }

  async listSessions(): Promise<SessionInfo[]> {
    let names: string[];
    try { names = fs.readdirSync(this.dir); } catch { return []; }
    const result: SessionInfo[] = [];
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const id = name.slice(0, -".jsonl".length);
      const filePath = path.join(this.dir, name);
      try {
        const store = new SessionStore(filePath);
        const meta = store.getMeta();
        result.push({
          id,
          filePath,
          createdAt: meta.createdAt,
          name: meta.name,
          preview: await store.getPreview(),
          entryCount: store.entryCount(),
        });
      } catch { /* skip unreadable */ }
    }
    result.sort((a, b) => b.createdAt - a.createdAt);
    return result;
  }

  private createFreshSession(): SessionStore {
    const id = newSessionFileId();
    const filePath = this.sessionFile(id);
    return new SessionStore(filePath, { create: { cwd: this.cwd, sessionId: id } });
  }

  private sessionFile(id: string): string {
    return path.join(this.dir, `${id}.jsonl`);
  }
}

function newSessionFileId(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const suffix = crypto.randomBytes(3).toString("hex");
  return `${ts}_${suffix}`;
}

