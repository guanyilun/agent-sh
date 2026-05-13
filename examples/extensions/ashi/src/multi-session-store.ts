import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { SessionStore, type AgentMessage } from "./session-store.js";

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
    this.migrateLegacy();
    this.currentStore = this.createFreshSession();
  }

  /** One-time import from the previous storage format (sessions stored as
   *  directories with tree.jsonl + snapshots/). Each old session is replayed
   *  from its most recent snapshot into a new flat `.jsonl` file, then the
   *  source directory is renamed `.migrated-<id>/` so the import is idempotent. */
  private migrateLegacy(): void {
    let names: string[];
    try { names = fs.readdirSync(this.dir); } catch { return; }
    for (const name of names) {
      if (name.startsWith(".migrated-")) continue;
      const full = path.join(this.dir, name);
      let stat: fs.Stats;
      try { stat = fs.statSync(full); } catch { continue; }
      if (!stat.isDirectory()) continue;
      const snapshotsDir = path.join(full, "snapshots");
      const leafFile = path.join(full, "active-leaf");
      let leaf: string;
      try { leaf = fs.readFileSync(leafFile, "utf-8").trim(); } catch { continue; }
      let messages: AgentMessage[];
      try {
        const raw = fs.readFileSync(path.join(snapshotsDir, `${leaf}.json`), "utf-8");
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) continue;
        messages = parsed as AgentMessage[];
      } catch { continue; }
      let createdAt = 0;
      let displayName: string | undefined;
      try {
        const m = JSON.parse(fs.readFileSync(path.join(full, "meta.json"), "utf-8"));
        if (typeof m?.createdAt === "number") createdAt = m.createdAt;
        if (typeof m?.name === "string") displayName = m.name;
      } catch { /* no meta */ }
      const newFile = path.join(this.dir, `${name}.jsonl`);
      try {
        writeImportedSession(newFile, name, this.cwd, messages, createdAt, displayName);
        fs.renameSync(full, path.join(this.dir, `.migrated-${name}`));
      } catch { /* leave the original directory alone if anything failed */ }
    }
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

  listSessions(): SessionInfo[] {
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
          preview: store.getPreview(),
          entryCount: store.getAllEntries().length,
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

function writeImportedSession(
  newFile: string,
  id: string,
  cwd: string,
  messages: AgentMessage[],
  createdAt: number,
  name?: string,
): void {
  const ts = createdAt || Date.now();
  const header = { type: "session", id, parentId: null, timestamp: ts, cwd, version: 1 };
  const lines: string[] = [JSON.stringify(header)];
  let parent: string = id;
  for (const m of messages) {
    const entryId = crypto.randomBytes(4).toString("hex");
    lines.push(JSON.stringify({ type: "message", id: entryId, parentId: parent, timestamp: ts, message: m }));
    parent = entryId;
  }
  fs.writeFileSync(newFile, lines.join("\n") + "\n");
  fs.writeFileSync(newFile + ".leaf", parent);
  fs.writeFileSync(newFile + ".meta", JSON.stringify({ createdAt: ts, ...(name ? { name } : {}) }));
}
