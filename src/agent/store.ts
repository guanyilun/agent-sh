import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as fss from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

export interface Entry {
  id: string;
  parentId?: string;
  ts: number;
  kind: string;
  payload: Record<string, unknown>;
}

export interface AppendOpts {
  /** Memory-only; never persisted. */
  ephemeral?: boolean;
}

export interface SearchHit {
  entry: Entry;
  line: string;
}

/** Append-only — no edit or delete. Implementations may apply bulk
 *  retention (front-truncation, GC), but strategies cannot remove a
 *  specific entry. */
export interface Store {
  append(entries: Entry[], opts?: AppendOpts): Promise<void>;
  findById(id: string): Promise<Entry | null>;
  readRecent(n?: number): Promise<Entry[]>;
  search(query: string): Promise<SearchHit[]>;
}

export interface TreeStore extends Store {
  getBranch(leafId?: string): Promise<Entry[]>;
  setLeaf(id: string): void;
  getLeaf(): string;
}

export function newEntryId(): string {
  return crypto.randomBytes(4).toString("hex");
}

export function isTreeStore(s: Store): s is TreeStore {
  return (
    typeof (s as TreeStore).setLeaf === "function" &&
    typeof (s as TreeStore).getLeaf === "function" &&
    typeof (s as TreeStore).getBranch === "function"
  );
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compileSearchRegex(query: string): RegExp {
  return new RegExp(escapeRegex(query), "i");
}

function matchEntry(entry: Entry, re: RegExp): SearchHit | null {
  const line = JSON.stringify(entry);
  return re.test(line) ? { entry, line } : null;
}

export class NoopStore implements Store {
  async append(): Promise<void> {}
  async findById(): Promise<Entry | null> { return null; }
  async readRecent(): Promise<Entry[]> { return []; }
  async search(): Promise<SearchHit[]> { return []; }
}

export class InMemoryStore implements TreeStore {
  private entries = new Map<string, Entry>();
  private order: string[] = [];
  private leaf: string;

  constructor(opts?: { root?: Entry }) {
    if (opts?.root) {
      this.entries.set(opts.root.id, opts.root);
      this.order.push(opts.root.id);
      this.leaf = opts.root.id;
    } else {
      this.leaf = "";
    }
  }

  async append(entries: Entry[]): Promise<void> {
    for (const e of entries) {
      this.entries.set(e.id, e);
      this.order.push(e.id);
    }
  }

  async findById(id: string): Promise<Entry | null> {
    return this.entries.get(id) ?? null;
  }

  async readRecent(n?: number): Promise<Entry[]> {
    const slice = n == null ? this.order : this.order.slice(-n);
    return slice.map((id) => this.entries.get(id)!);
  }

  async search(query: string): Promise<SearchHit[]> {
    if (!query.trim()) return [];
    const re = compileSearchRegex(query);
    const out: SearchHit[] = [];
    for (let i = this.order.length - 1; i >= 0; i--) {
      const m = matchEntry(this.entries.get(this.order[i]!)!, re);
      if (m) out.push(m);
    }
    return out;
  }

  async getBranch(leafId: string = this.leaf): Promise<Entry[]> {
    const out: Entry[] = [];
    const seen = new Set<string>();
    let cur: string | undefined = leafId;
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const e = this.entries.get(cur);
      if (!e) break;
      out.push(e);
      cur = e.parentId;
    }
    return out.reverse();
  }

  setLeaf(id: string): void {
    if (!this.entries.has(id)) throw new Error(`unknown entry: ${id}`);
    this.leaf = id;
  }

  getLeaf(): string {
    return this.leaf;
  }
}

/** Single-writer JSONL Store with a `.leaf` sidecar for the active
 *  leaf. Suitable for per-session transcripts. See SharedFileStore for
 *  the multi-writer case. */
export interface FileStoreOpts {
  filePath: string;
  /** Optional root entry written on first append if the file is empty. */
  root?: Entry;
}

export class FileStore implements TreeStore {
  private filePath: string;
  private leafPath: string;
  private entries = new Map<string, Entry>();
  private order: string[] = [];
  private leaf = "";
  private pendingRoot: Entry | null = null;

  constructor(opts: FileStoreOpts) {
    this.filePath = opts.filePath;
    this.leafPath = opts.filePath + ".leaf";
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });

    if (this.tryLoad()) return;

    if (opts.root) {
      this.entries.set(opts.root.id, opts.root);
      this.order.push(opts.root.id);
      this.leaf = opts.root.id;
      this.pendingRoot = opts.root;
    }
  }

  async append(entries: Entry[], opts?: AppendOpts): Promise<void> {
    if (entries.length === 0) return;
    this.flushRoot();
    for (const e of entries) {
      this.entries.set(e.id, e);
      this.order.push(e.id);
    }
    if (!opts?.ephemeral) {
      const lines = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
      await fsp.appendFile(this.filePath, lines);
    }
  }

  async findById(id: string): Promise<Entry | null> {
    return this.entries.get(id) ?? null;
  }

  async readRecent(n?: number): Promise<Entry[]> {
    const slice = n == null ? this.order : this.order.slice(-n);
    return slice.map((id) => this.entries.get(id)!);
  }

  async search(query: string): Promise<SearchHit[]> {
    if (!query.trim()) return [];
    const re = compileSearchRegex(query);
    const out: SearchHit[] = [];
    for (let i = this.order.length - 1; i >= 0; i--) {
      const m = matchEntry(this.entries.get(this.order[i]!)!, re);
      if (m) out.push(m);
    }
    return out;
  }

  async getBranch(leafId: string = this.leaf): Promise<Entry[]> {
    const out: Entry[] = [];
    const seen = new Set<string>();
    let cur: string | undefined = leafId;
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const e = this.entries.get(cur);
      if (!e) break;
      out.push(e);
      cur = e.parentId;
    }
    return out.reverse();
  }

  setLeaf(id: string): void {
    if (!this.entries.has(id)) throw new Error(`unknown entry: ${id}`);
    this.leaf = id;
    if (!this.pendingRoot) fs.writeFileSync(this.leafPath, id);
  }

  getLeaf(): string {
    return this.leaf;
  }

  /** Sync — id of the first entry, "" if empty. */
  getRootId(): string {
    return this.order[0] ?? "";
  }

  /** Sync — total entries including the root. */
  size(): number {
    return this.entries.size;
  }

  private tryLoad(): boolean {
    let raw: string;
    try { raw = fs.readFileSync(this.filePath, "utf-8"); }
    catch { return false; }
    for (const line of raw.split("\n")) {
      if (!line) continue;
      try {
        const e = JSON.parse(line) as Entry;
        if (!e.id) continue;
        this.entries.set(e.id, e);
        this.order.push(e.id);
      } catch { /* skip malformed */ }
    }
    try {
      const stored = fs.readFileSync(this.leafPath, "utf-8").trim();
      this.leaf = this.entries.has(stored) ? stored : (this.order[this.order.length - 1] ?? "");
    } catch {
      this.leaf = this.order[this.order.length - 1] ?? "";
    }
    return this.order.length > 0;
  }

  private flushRoot(): void {
    if (!this.pendingRoot) return;
    const rootLine = JSON.stringify(this.pendingRoot) + "\n";
    this.pendingRoot = null;
    fs.writeFileSync(this.filePath, rootLine);
    fs.writeFileSync(this.leafPath, this.leaf);
  }
}

/** Multi-writer JSONL Store. O_APPEND with PIPE_BUF-bounded line
 *  writes for atomic concurrent appends; lock-based front-truncation
 *  for retention; reads stream the tail for cheap recent slices. */
const LOCK_STALE_MS = 10_000;
const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;

export interface SharedFileStoreOpts {
  filePath: string;
  /** Front-truncate above this size; truncation fires at 150% of the
   *  cap to avoid frequent rewrites. */
  maxBytes?: number;
}

export class SharedFileStore implements Store {
  private filePath: string;
  private lockPath: string;
  private maxBytes: number;

  constructor(opts: SharedFileStoreOpts) {
    this.filePath = opts.filePath;
    this.lockPath = opts.filePath + ".lock";
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    try { fs.mkdirSync(path.dirname(this.filePath), { recursive: true }); } catch { /* ignore */ }
  }

  async append(entries: Entry[], opts?: AppendOpts): Promise<void> {
    if (entries.length === 0) return;
    if (opts?.ephemeral) return; // memory-only writes are a no-op on a file-only store
    const lines = entries.map((e) => JSON.stringify(e) + "\n").join("");
    await fsp.appendFile(this.filePath, lines, { flag: "a" });
    await this.maybeTruncate();
  }

  async findById(id: string): Promise<Entry | null> {
    for await (const line of this.streamReverseLines()) {
      try {
        const e = JSON.parse(line) as Entry;
        if (e.id === id) return e;
      } catch { /* skip malformed */ }
    }
    return null;
  }

  async readRecent(n?: number): Promise<Entry[]> {
    const want = n ?? Infinity;
    const recent: Entry[] = []; // newest-first
    for await (const line of this.streamReverseLines()) {
      try {
        const e = JSON.parse(line) as Entry;
        if (!e.id) continue;
        recent.push(e);
        if (recent.length >= want) break;
      } catch { /* skip malformed */ }
    }
    return recent.reverse();
  }

  async search(query: string): Promise<SearchHit[]> {
    if (!query.trim()) return [];
    const re = compileSearchRegex(query);
    const budgetBytes = 20 * 1024 * 1024;
    let scanned = 0;
    const out: SearchHit[] = [];
    for await (const line of this.streamReverseLines()) {
      scanned += line.length + 1;
      if (scanned > budgetBytes) break;
      try {
        const e = JSON.parse(line) as Entry;
        const m = matchEntry(e, re);
        if (m) out.push(m);
      } catch { /* skip malformed */ }
    }
    return out;
  }

  /** Yield lines newest-first by reading reverse-chunked blocks,
   *  stitching across boundaries. */
  private async *streamReverseLines(chunkBytes = 1 << 20): AsyncGenerator<string> {
    let handle: fsp.FileHandle;
    let fileSize: number;
    try {
      const stat = await fsp.stat(this.filePath);
      fileSize = stat.size;
      if (fileSize === 0) return;
      handle = await fsp.open(this.filePath, "r");
    } catch {
      return;
    }
    try {
      let position = fileSize;
      let pending: Buffer = Buffer.alloc(0);
      while (position > 0) {
        const readSize = Math.min(chunkBytes, position);
        position -= readSize;
        const buf = Buffer.alloc(readSize);
        await handle.read(buf, 0, readSize, position);
        const combined = Buffer.concat([buf, pending]);
        const newlineIdxs: number[] = [];
        for (let i = 0; i < combined.length; i++) {
          if (combined[i] === 0x0A) newlineIdxs.push(i);
        }
        if (newlineIdxs.length === 0) { pending = combined; continue; }
        const firstNl = newlineIdxs[0]!;
        const lastNl = newlineIdxs[newlineIdxs.length - 1]!;
        const trailing = combined.subarray(lastNl + 1);
        if (trailing.length > 0) yield trailing.toString("utf-8");
        for (let i = newlineIdxs.length - 1; i >= 1; i--) {
          const seg = combined.subarray(newlineIdxs[i - 1]! + 1, newlineIdxs[i]!);
          if (seg.length > 0) yield seg.toString("utf-8");
        }
        const leading = combined.subarray(0, firstNl);
        if (position === 0) {
          if (leading.length > 0) yield leading.toString("utf-8");
          pending = Buffer.alloc(0);
        } else {
          pending = leading;
        }
      }
      if (pending.length > 0) yield pending.toString("utf-8");
    } finally {
      await handle.close();
    }
  }

  private async maybeTruncate(): Promise<void> {
    let size = 0;
    try { size = (await fsp.stat(this.filePath)).size; } catch { return; }
    if (size <= this.maxBytes * 1.5) return;

    if (!(await this.acquireLock())) return;
    try {
      let content: string;
      try { content = await fsp.readFile(this.filePath, "utf-8"); }
      catch { return; }

      const lines = content.split("\n").filter(Boolean);
      let totalBytes = Buffer.byteLength(content, "utf-8");
      let dropCount = 0;
      while (totalBytes > this.maxBytes && dropCount < lines.length - 1) {
        totalBytes -= Buffer.byteLength(lines[dropCount]! + "\n", "utf-8");
        dropCount++;
      }
      if (dropCount === 0) return;

      const remaining = lines.slice(dropCount).join("\n") + "\n";
      const tmpPath = this.filePath + ".tmp." + process.pid;
      await fsp.writeFile(tmpPath, remaining);
      await fsp.rename(tmpPath, this.filePath);
    } finally {
      await this.releaseLock();
    }
  }

  private async acquireLock(): Promise<boolean> {
    try {
      try {
        const stat = await fsp.stat(this.lockPath);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          await fsp.unlink(this.lockPath).catch(() => {});
        }
      } catch { /* lock absent — good */ }
      const fd = await fsp.open(this.lockPath, fss.constants.O_CREAT | fss.constants.O_EXCL | fss.constants.O_WRONLY);
      await fd.close();
      return true;
    } catch {
      return false;
    }
  }

  private async releaseLock(): Promise<void> {
    await fsp.unlink(this.lockPath).catch(() => {});
  }
}
