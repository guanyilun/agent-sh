export type JobStatus = "running" | "done" | "failed" | "cancelled";

export interface JobOutcome { content: string; isError: boolean }

export interface Job {
  id: number;
  label: string;
  status: JobStatus;
  startedAt: number;
  endedAt?: number;
  lastProgress: string;
  result: string;
  /** The agent has received the result through a tool call. */
  read: boolean;
  /** A wake note has told the agent the run finished. */
  announced: boolean;
  controller: AbortController;
}

export class JobTable {
  private jobs = new Map<number, Job>();
  private nextId = 1;
  private waiters = new Set<() => void>();

  constructor(private readonly onSettle: (job: Job) => void) {}

  start(label: string, work: (signal: AbortSignal, progress: (line: string) => void) => Promise<JobOutcome>): Job {
    const job: Job = {
      id: this.nextId++, label, status: "running", startedAt: Date.now(),
      lastProgress: "", result: "", read: false, announced: false, controller: new AbortController(),
    };
    this.jobs.set(job.id, job);
    work(job.controller.signal, (line) => { job.lastProgress = line; }).then(
      (r) => this.settle(job, r.isError ? "failed" : "done", r.content),
      (err) => this.settle(job, "failed", err instanceof Error ? err.message : String(err)),
    );
    return job;
  }

  get(id: number): Job | undefined { return this.jobs.get(id); }
  list(): Job[] { return [...this.jobs.values()]; }
  running(): Job[] { return this.list().filter(j => j.status === "running"); }
  unread(): Job[] { return this.list().filter(j => j.status !== "running" && !j.read); }

  cancel(job: Job): void {
    job.controller.abort();
    this.settle(job, "cancelled", "(cancelled)");
  }

  /** Cancels everything and forgets it, so nothing is announced into a reset session. */
  clear(): void {
    for (const job of this.running()) this.cancel(job);
    this.jobs.clear();
  }

  /** Marks the result as delivered and returns it for a tool result. */
  read(job: Job): string {
    job.read = true;
    return `Run #${job.id} (${job.label}) ${job.status} after ${duration(job)}:\n\n${job.result || "(no response)"}`;
  }

  /** Resolves when every job has settled, the timeout passes, or the signal aborts. */
  wait(jobs: Job[], timeoutMs: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const check = () => {
        if (jobs.every(j => j.status !== "running") || signal?.aborted) done();
      };
      const done = () => {
        clearTimeout(timer);
        this.waiters.delete(check);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      signal?.addEventListener("abort", done);
      this.waiters.add(check);
      check();
    });
  }

  private settle(job: Job, status: JobStatus, result: string): void {
    if (job.status !== "running") return;
    // An aborted run reports whatever partial text it had; keep it but call it cancelled.
    job.status = job.controller.signal.aborted ? "cancelled" : status;
    job.result = result;
    job.endedAt = Date.now();
    for (const check of [...this.waiters]) check();
    this.onSettle(job);
  }
}

export function duration(job: Job): string {
  const s = Math.round(((job.endedAt ?? Date.now()) - job.startedAt) / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

export function describe(job: Job): string {
  const state = job.status === "running"
    ? `running ${duration(job)}${job.lastProgress ? ` (last: ${job.lastProgress})` : ""}`
    : `${job.status}${job.read ? "" : ", unread"}`;
  return `#${job.id} ${job.label}: ${state}`;
}
