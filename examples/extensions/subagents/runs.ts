import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export type RunStatus = "running" | "done" | "failed" | "cancelled";

export interface RunRecord {
  id: string;
  workflow: string;
  file: string;
  args: string;
  status: RunStatus;
  startedAt: string;
  endedAt?: string;
  resumedFrom?: string;
  tokens: number;
  error?: string;
}

/** A running run touches run.json this often, so other processes can tell running from interrupted. */
const HEARTBEAT_MS = 30_000;

export interface JournalEntry {
  seq: number;
  /** Position in the script, e.g. "2", or "3.0/1" for map/pipeline 3, item 0, first run. */
  id?: string;
  /** Hash of the run() inputs; a replayed entry must match it. */
  key: string;
  agent?: string;
  output: unknown;
  tokens: number;
  /** agent() turns: the messages this turn added to the conversation. */
  added?: unknown[];
  /** race(): the index of the item that won. */
  winner?: number;
}

export class RunStore {
  private active = new Set<string>();

  constructor(private readonly root: string) {}

  create(workflow: string, file: string, args: string, resumedFrom?: string): RunDir {
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
    const id = `${stamp}-${randomBytes(2).toString("hex")}`;
    const dir = path.join(this.root, id);
    fs.mkdirSync(path.join(dir, "agents"), { recursive: true });
    const record: RunRecord = {
      id, workflow, file, args, status: "running", startedAt: new Date().toISOString(), resumedFrom, tokens: 0,
    };
    this.active.add(id);
    const run = new RunDir(dir, record, () => this.active.delete(id));
    run.save();
    return run;
  }

  get(id: string): RunRecord | undefined {
    try { return JSON.parse(fs.readFileSync(path.join(this.root, id, "run.json"), "utf8")); } catch { return undefined; }
  }

  journal(id: string): JournalEntry[] {
    try {
      return fs.readFileSync(path.join(this.root, id, "journal.jsonl"), "utf8")
        .split("\n").filter(Boolean).map(line => JSON.parse(line));
    } catch { return []; }
  }

  list(limit = 10): (RunRecord & { interrupted: boolean })[] {
    let ids: string[];
    try { ids = fs.readdirSync(this.root); } catch { return []; }
    // Newest first by start time: ids from the same second differ only in a random suffix.
    return ids.map(id => this.get(id)).filter((r): r is RunRecord => !!r)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id))
      .slice(0, limit)
      .map(r => ({ ...r, interrupted: r.status === "running" && !this.active.has(r.id) && !this.beating(r.id) }));
  }

  private beating(id: string): boolean {
    try { return Date.now() - fs.statSync(path.join(this.root, id, "run.json")).mtimeMs < 3 * HEARTBEAT_MS; } catch { return false; }
  }

  status(id?: string, now = Date.now()): string {
    const r = id ? this.list(Infinity).find(x => x.id === id) : this.list(1)[0];
    if (!r) return id ? `No workflow run ${id}.` : "No workflow runs yet.";
    const dir = path.join(this.root, r.id, "agents");
    const state = r.interrupted ? "interrupted" : r.status === "running" ? "running" : r.status;
    const lines = [`${r.id}  ${r.workflow}  ${state}, ${duration((r.endedAt ? Date.parse(r.endedAt) : now) - Date.parse(r.startedAt))}, ${r.tokens} tokens`];
    let files: string[] = [];
    try { files = fs.readdirSync(dir).filter(f => f.endsWith(".jsonl")).sort((a, b) => parseInt(a) - parseInt(b)); } catch {}
    for (const f of files) {
      const events = readEvents(path.join(dir, f));
      const at = (type: string) => events.find(e => e.type === type)?.at as number | undefined;
      const end = events.find(e => e.type === "end");
      const started = at("running") ?? at("message");
      const s = end ? (end.ok ? "done" : "failed") : !r.interrupted && r.status === "running" ? (started ? "working" : "queued") : "stopped";
      const since = end ? (end.at as number | undefined) ?? now : now;
      const from = s === "queued" ? at("start") : started;
      const task = String(events[0]?.task ?? "").split("\n")[0]!.slice(0, 70);
      lines.push(`  #${f.slice(0, -6).padStart(2)}  ${s.padEnd(7)}  ${(from ? duration(since - from) : "").padStart(6)}  ${task}`);
    }
    if (r.error) lines.push(`  ${r.error}`);
    return lines.join("\n");
  }
}

function readEvents(file: string): Record<string, unknown>[] {
  try { return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l)); } catch { return []; }
}

function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s` : `${Math.floor(s / 3600)}h${String(Math.floor(s / 60) % 60).padStart(2, "0")}m`;
}

export class RunDir {
  private readonly heartbeat: NodeJS.Timeout;

  constructor(readonly dir: string, readonly record: RunRecord, private readonly onFinish: () => void) {
    this.heartbeat = setInterval(() => { try { const t = new Date(); fs.utimesSync(path.join(dir, "run.json"), t, t); } catch {} }, HEARTBEAT_MS);
    this.heartbeat.unref();
  }

  get id(): string { return this.record.id; }

  save(): void {
    fs.writeFileSync(path.join(this.dir, "run.json"), JSON.stringify(this.record, null, 2));
  }

  append(entry: JournalEntry): void {
    fs.appendFileSync(path.join(this.dir, "journal.jsonl"), JSON.stringify(entry) + "\n");
    this.save();  // keep the token count current in case the process dies
  }

  transcript(seq: number): (event: Record<string, unknown>) => void {
    const file = path.join(this.dir, "agents", `${seq}.jsonl`);
    return (event) => fs.appendFileSync(file, JSON.stringify({ ...event, at: Date.now() }) + "\n");
  }

  finish(status: RunStatus, error?: string): void {
    clearInterval(this.heartbeat);
    this.record.status = status;
    this.record.endedAt = new Date().toISOString();
    if (error) this.record.error = error;
    this.save();
    this.onFinish();
  }
}
