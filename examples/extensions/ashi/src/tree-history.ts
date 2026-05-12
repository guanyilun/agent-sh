import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import {
  type HistoryAdapter,
  type NuclearEntry,
  compileSearchRegex,
  matchEntry,
} from "agent-sh/core";

export class TreeHistoryAdapter implements HistoryAdapter {
  private entriesPath: string;
  private leafPath: string;
  private entries = new Map<number, NuclearEntry>();
  private activeLeaf = 0;

  constructor(dir: string) {
    this.entriesPath = path.join(dir, "tree.jsonl");
    this.leafPath = path.join(dir, "active-leaf");
    fs.mkdirSync(dir, { recursive: true });
    this.loadFromDisk();
  }

  private loadFromDisk(): void {
    try {
      const raw = fs.readFileSync(this.entriesPath, "utf-8");
      for (const line of raw.split("\n")) {
        if (!line) continue;
        try {
          const e = JSON.parse(line) as NuclearEntry;
          if (typeof e.seq === "number") this.entries.set(e.seq, e);
        } catch { /* skip malformed line */ }
      }
    } catch { /* fresh file */ }
    try {
      this.activeLeaf = parseInt(fs.readFileSync(this.leafPath, "utf-8").trim(), 10) || 0;
    } catch { this.activeLeaf = this.highestSeq(); }
  }

  private highestSeq(): number {
    let max = 0;
    for (const seq of this.entries.keys()) if (seq > max) max = seq;
    return max;
  }

  private persistLeaf(): void {
    fs.writeFileSync(this.leafPath, String(this.activeLeaf));
  }

  async append(batch: NuclearEntry[]): Promise<void> {
    if (batch.length === 0) return;
    let parent = this.activeLeaf;
    const lines: string[] = [];
    for (const e of batch) {
      if (e.parentSeq == null) e.parentSeq = parent;
      this.entries.set(e.seq, e);
      lines.push(JSON.stringify(e));
      parent = e.seq;
    }
    this.activeLeaf = parent;
    await fsp.appendFile(this.entriesPath, lines.join("\n") + "\n");
    this.persistLeaf();
  }

  async readRecent(maxEntries?: number): Promise<NuclearEntry[]> {
    const branch = this.walkBranch(this.activeLeaf);
    return maxEntries ? branch.slice(-maxEntries) : branch;
  }

  async search(query: string): Promise<{ entry: NuclearEntry; line: string }[]> {
    if (!query.trim()) return [];
    const re = compileSearchRegex(query);
    const hits: { entry: NuclearEntry; line: string }[] = [];
    for (const e of [...this.entries.values()].sort((a, b) => b.seq - a.seq)) {
      const m = matchEntry(e, re);
      if (m) hits.push(m);
    }
    return hits;
  }

  async findBySeq(seq: number): Promise<NuclearEntry | null> {
    return this.entries.get(seq) ?? null;
  }

  async getBranch(leafSeq: number): Promise<NuclearEntry[]> {
    return this.walkBranch(leafSeq);
  }

  async getTree(): Promise<NuclearEntry[]> {
    return [...this.entries.values()].sort((a, b) => a.seq - b.seq);
  }

  setLeaf(seq: number): void {
    if (!this.entries.has(seq) && seq !== 0) {
      throw new Error(`Unknown seq: ${seq}`);
    }
    this.activeLeaf = seq;
    this.persistLeaf();
  }

  getActiveLeaf(): number { return this.activeLeaf; }

  private walkBranch(leaf: number): NuclearEntry[] {
    const out: NuclearEntry[] = [];
    const seen = new Set<number>();
    let cur: number | undefined = leaf;
    while (cur && cur !== 0 && !seen.has(cur)) {
      seen.add(cur);
      const e = this.entries.get(cur);
      if (!e) break;
      out.push(e);
      cur = e.parentSeq;
    }
    return out.reverse();
  }
}
