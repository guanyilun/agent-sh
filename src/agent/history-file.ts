/**
 * Persistent history file — append-only JSONL at ~/.agent-sh/history.
 *
 * Multiple agent-sh instances can write concurrently — each line is under
 * PIPE_BUF so O_APPEND writes are atomic. Only truncation (which rewrites
 * the file) uses a lock file for safety.
 */
import * as fs from "node:fs/promises";
import * as fss from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { CONFIG_DIR, getSettings } from "../settings.js";
import {
  type NuclearEntry,
  serializeEntry,
  deserializeEntry,
  formatNuclearLine,
  isReadOnly,
} from "./nuclear-form.js";

const HISTORY_PATH = path.join(CONFIG_DIR, "history");
const LOCK_STALE_MS = 10_000; // consider lock stale after 10s

export class HistoryFile {
  readonly instanceId: string;
  private filePath: string;
  private lockPath: string;

  constructor(opts?: { filePath?: string; instanceId?: string }) {
    this.filePath = opts?.filePath ?? HISTORY_PATH;
    this.lockPath = this.filePath + ".lock";
    this.instanceId = opts?.instanceId ?? crypto.randomBytes(2).toString("hex");
    // Custom paths may target a dir that doesn't exist yet; create sync so
    // the first append() can't race with the mkdir.
    try { fss.mkdirSync(path.dirname(this.filePath), { recursive: true }); } catch { /* ignore */ }
  }

  /**
   * Append entries atomically. Uses O_APPEND for concurrency safety.
   * Triggers truncation check after writing.
   */
  async append(entries: NuclearEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const lines = entries.map((e) => serializeEntry(e) + "\n").join("");
    await fs.appendFile(this.filePath, lines, { flag: "a" });
    await this.maybeTruncate();
  }

  /**
   * Read the most recent N entries from the history file, filtered.
   * Read-only tool calls (read_file, grep, glob, ls) are excluded so
   * the returned entries are all meaningful conversation turns.
   */
  async readRecent(maxEntries?: number): Promise<NuclearEntry[]> {
    maxEntries ??= getSettings().historyStartupEntries;
    const want = maxEntries * 3 + 10;
    const recent: NuclearEntry[] = []; // newest-first
    for await (const line of this.streamReverseLines()) {
      const entry = deserializeEntry(line);
      if (entry && !isReadOnly(entry)) recent.push(entry);
      if (recent.length >= want) break;
    }
    // Caller expects oldest-to-newest order.
    return recent.reverse().slice(-maxEntries);
  }

  /**
   * Search history entries by regex/keyword, scanning the file from the
   * end. Caps at ~20 MB of content to bound cost on 100 MB history files.
   */
  async search(query: string): Promise<{ entry: NuclearEntry; line: string }[]> {
    if (!query.trim()) return [];

    let regex: RegExp;
    try {
      regex = new RegExp(query, "i");
    } catch {
      const words = query.split(/\s+/).filter((w) => w.length > 0);
      const escaped = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
      const lookaheads = escaped.map((w) => `(?=.*${w})`).join("");
      regex = new RegExp(lookaheads, "i");
    }

    const budgetBytes = 20 * 1024 * 1024;
    let scanned = 0;
    const results: { entry: NuclearEntry; line: string }[] = [];
    for await (const line of this.streamReverseLines()) {
      scanned += line.length + 1;
      if (scanned > budgetBytes) break;
      const entry = deserializeEntry(line);
      if (!entry || isReadOnly(entry)) continue;
      // Body can hold ~4000 chars the summary truncates — search both.
      const searchText = [entry.sum, entry.body].filter(Boolean).join("\n");
      if (regex.test(searchText)) {
        results.push({ entry, line: formatNuclearLine(entry) });
      }
    }
    return results;
  }

  /** Find a single entry by sequence number, streaming from the file end. */
  async findBySeq(seq: number): Promise<NuclearEntry | null> {
    for await (const line of this.streamReverseLines()) {
      const entry = deserializeEntry(line);
      if (entry && entry.seq === seq) return entry;
    }
    return null;
  }

  async getSize(): Promise<number> {
    try {
      const stat = await fs.stat(this.filePath);
      return stat.size;
    } catch {
      return 0;
    }
  }

  /**
   * Yield lines from the file in reverse order (newest-first). Buffers
   * pre-first-newline bytes across chunks to stitch lines that straddle
   * a boundary; carries raw bytes (not strings) so UTF-8 characters split
   * by a chunk boundary are never decoded mid-codepoint.
   */
  private async *streamReverseLines(chunkBytes = 1 << 20): AsyncGenerator<string> {
    let handle: fs.FileHandle;
    let fileSize: number;
    try {
      const stat = await fs.stat(this.filePath);
      fileSize = stat.size;
      if (fileSize === 0) return;
      handle = await fs.open(this.filePath, "r");
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
        // pending: start-bytes of a line whose first \n lives in this chunk.
        const combined = Buffer.concat([buf, pending]);

        const newlineIdxs: number[] = [];
        for (let i = 0; i < combined.length; i++) {
          if (combined[i] === 0x0A) newlineIdxs.push(i);
        }

        if (newlineIdxs.length === 0) {
          pending = combined;
          continue;
        }

        const firstNl = newlineIdxs[0]!;
        const lastNl = newlineIdxs[newlineIdxs.length - 1]!;

        // Post-last-\n: a line straddling into the later chunk (completed
        // here because `pending` was appended at the end of `combined`).
        const trailing = combined.subarray(lastNl + 1);
        if (trailing.length > 0) yield trailing.toString("utf-8");

        for (let i = newlineIdxs.length - 1; i >= 1; i--) {
          const seg = combined.subarray(newlineIdxs[i - 1]! + 1, newlineIdxs[i]!);
          if (seg.length > 0) yield seg.toString("utf-8");
        }

        // Pre-first-\n: partial if there's more file to the left, else complete.
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

  // ── Truncation ──────────────────────────────────────────────────

  /**
   * Truncate from the front if file exceeds historyMaxBytes.
   * Uses a lock file for the rewrite operation.
   */
  private async maybeTruncate(): Promise<void> {
    const maxBytes = getSettings().historyMaxBytes;
    const size = await this.getSize();
    // Only truncate when significantly over (150%) to avoid frequent rewrites
    if (size <= maxBytes * 1.5) return;

    const acquired = await this.acquireLock();
    if (!acquired) return; // another process is truncating

    try {
      let content: string;
      try {
        content = await fs.readFile(this.filePath, "utf-8");
      } catch {
        return;
      }

      const lines = content.split("\n").filter(Boolean);
      // Drop oldest lines until under maxBytes
      let totalBytes = Buffer.byteLength(content, "utf-8");
      let dropCount = 0;
      while (totalBytes > maxBytes && dropCount < lines.length - 1) {
        totalBytes -= Buffer.byteLength(lines[dropCount]! + "\n", "utf-8");
        dropCount++;
      }

      if (dropCount === 0) return;

      const remaining = lines.slice(dropCount).join("\n") + "\n";
      // Atomic rewrite: write temp → rename
      const tmpPath = this.filePath + ".tmp." + process.pid;
      await fs.writeFile(tmpPath, remaining);
      await fs.rename(tmpPath, this.filePath);
    } finally {
      await this.releaseLock();
    }
  }

  private async acquireLock(): Promise<boolean> {
    try {
      // Check for stale lock
      try {
        const stat = await fs.stat(this.lockPath);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          await fs.unlink(this.lockPath).catch(() => {});
        }
      } catch {
        // Lock doesn't exist — good
      }
      // O_EXCL ensures atomicity
      const fd = await fs.open(this.lockPath, fss.constants.O_CREAT | fss.constants.O_EXCL | fss.constants.O_WRONLY);
      await fd.close();
      return true;
    } catch {
      return false; // lock held by another process
    }
  }

  private async releaseLock(): Promise<void> {
    await fs.unlink(this.lockPath).catch(() => {});
  }
}
