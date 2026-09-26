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

export interface JournalEntry {
  seq: number;
  /** Hash of the run() inputs; a replayed entry must match it. */
  key: string;
  agent?: string;
  output: unknown;
  tokens: number;
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

  // "running" on disk but not live in this process means it was interrupted.
  list(limit = 10): (RunRecord & { interrupted: boolean })[] {
    let ids: string[];
    try { ids = fs.readdirSync(this.root).sort().reverse(); } catch { return []; }
    return ids.slice(0, limit).map(id => this.get(id)).filter((r): r is RunRecord => !!r)
      .map(r => ({ ...r, interrupted: r.status === "running" && !this.active.has(r.id) }));
  }
}

export class RunDir {
  constructor(readonly dir: string, readonly record: RunRecord, private readonly onFinish: () => void) {}

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
    return (event) => fs.appendFileSync(file, JSON.stringify(event) + "\n");
  }

  finish(status: RunStatus, error?: string): void {
    this.record.status = status;
    this.record.endedAt = new Date().toISOString();
    if (error) this.record.error = error;
    this.save();
    this.onFinish();
  }
}
