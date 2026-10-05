/** Runs a Python workflow file as a child process that drives this extension over a pipe; see WORKFLOWS.md ("Python"). */
import { spawn } from "node:child_process";
import * as path from "node:path";
import * as readline from "node:readline";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import type { RunSpec, WorkflowApi } from "./workflow-types.js";

const LIB = path.join(path.dirname(fileURLToPath(import.meta.url)), "python");
const HELLO_MS = 30_000;
/** How long the script gets to clean up after itself (e.g. shut down a Ray cluster it started) before it is killed. */
const EXIT_MS = 10_000;

/** What a script in another process needs beyond WorkflowApi: it numbers its own calls. */
export interface ScriptHost {
  run(spec: RunSpec, id: string, scope: string, session?: string): { done: Promise<unknown>; abort(): void };
  /** Resolves once every aborted run has stopped. */
  quiet(): Promise<void>;
  raceWinner(id: string, key: string, scope: string): number | undefined;
  raceRecord(id: string, key: string, winner: number): void;
  checkpointResult(id: string, key: string, scope: string, name: string): { value: unknown } | undefined;
  checkpointRecord(id: string, key: string, value: unknown): void;
  kind(err: unknown): "stop" | "cancelled" | "error";
  stop(message: string): Error;
}

export interface PythonModule {
  description: string;
  args?: Record<string, unknown>;
  default: (api: WorkflowApi, host: ScriptHost) => Promise<unknown>;
  dispose(): void;
  [key: string]: unknown;
}

export const isPython = (file: string) => file.endsWith(".py");
export const defaultPython = () => process.env.AGENT_SH_PYTHON || "python3";

export function pythonModule(file: string, python = defaultPython()): Promise<PythonModule> {
  const child = spawn(python, ["-u", "-B", "-m", "agentsh", file, "3", "4"], {
    env: { ...process.env, PYTHONPATH: [LIB, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter) },
    stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
  });
  const toChild = child.stdio[3] as Writable;
  const send = (message: unknown) => { if (toChild.writable) toChild.write(`${JSON.stringify(message)}\n`); };
  toChild.on("error", () => {});
  const running = () => child.exitCode === null && child.signalCode === null;
  // SIGTERM lets Python run its exit handlers; SIGKILL is for a script that won't go.
  const dispose = () => {
    if (!running()) return;
    child.kill("SIGTERM");
    setTimeout(() => { if (running()) child.kill("SIGKILL"); }, EXIT_MS).unref();
  };

  const errors: string[] = [];
  let print = (_line: string) => {};
  let onMessage = (_m: any) => {};
  let onExit = (_why: string) => {};
  readline.createInterface({ input: child.stdout! }).on("line", (line) => print(line));
  readline.createInterface({ input: child.stderr! }).on("line", (line) => { errors.push(line); if (errors.length > 20) errors.shift(); print(line); });
  readline.createInterface({ input: child.stdio[4] as Readable }).on("line", (line) => {
    try { onMessage(JSON.parse(line)); } catch { /* not ours */ }
  });
  child.on("error", (err: NodeJS.ErrnoException) =>
    onExit(err.code === "ENOENT" ? `${python} not found (set AGENT_SH_PYTHON, or \`python\` in the file's config)` : err.message));
  child.on("exit", (code, sig) => onExit(`python exited (${sig ?? code}) before finishing${errors.length ? `:\n${errors.join("\n")}` : ""}`));

  return new Promise<PythonModule>((resolve, reject) => {
    const timer = setTimeout(() => { dispose(); reject(new Error(`${file} did not start within ${HELLO_MS / 1000}s`)); }, HELLO_MS);
    onExit = (why) => { clearTimeout(timer); reject(new Error(why)); };
    onMessage = (hello) => {
      clearTimeout(timer);
      onExit = () => {};
      if (hello.t !== "hello" || hello.error) { dispose(); reject(new Error(`could not load ${file}: ${hello.error ?? "bad handshake"}`)); return; }
      resolve({ description: String(hello.description ?? ""), args: hello.args ?? undefined, default: drive, dispose });
    };
  });

  function drive(api: WorkflowApi, host: ScriptHost): Promise<unknown> {
    const usage = () => ({ total: api.budget.total, spent: api.budget.spent() });
    const reply = (rid: number, work: () => unknown) => Promise.resolve().then(work).then(
      (value) => send({ rid, ok: true, value: value ?? null, budget: usage() }),
      (err) => {
        const kind = host.kind(err);
        send({ rid, ok: false, error: err instanceof Error ? err.message : String(err), stop: kind === "stop", cancelled: kind === "cancelled", budget: usage() });
      });
    const aborts = new Map<number, () => void>();
    return new Promise<unknown>((resolve, reject) => {
      print = (line) => api.log(line);
      onExit = (why) => reject(api.signal.aborted ? host.stop("cancelled") : new Error(why));
      api.signal.addEventListener("abort", dispose, { once: true });
      onMessage = (m) => {
        if (m.t === "run") {
          // Started here, not in reply(): an "abandon" may be the very next line.
          const run = host.run(m.spec, m.id, m.scope, m.session);
          aborts.set(m.rid, run.abort);
          reply(m.rid, () => run.done.finally(() => aborts.delete(m.rid)));
        }
        // The script stopped waiting for this reply (a cancelled task, a lost race, a timeout).
        else if (m.t === "abandon") aborts.get(m.rid)?.();
        else if (m.t === "quiet") reply(m.rid, () => host.quiet());
        else if (m.t === "race_get") reply(m.rid, () => host.raceWinner(m.id, m.key, m.scope));
        else if (m.t === "race_set") reply(m.rid, () => host.raceRecord(m.id, m.key, m.winner));
        else if (m.t === "checkpoint_get") {
          reply(m.rid, () => {
            const hit = host.checkpointResult(m.id, m.key, m.scope, m.name);
            return { found: !!hit, value: hit?.value ?? null };
          });
        }
        else if (m.t === "checkpoint_set") reply(m.rid, () => host.checkpointRecord(m.id, m.key, m.value));
        else if (m.t === "log") api.log(String(m.message));
        else if (m.t === "done") finish(() => resolve(m.result ?? undefined));
        else if (m.t === "fail") finish(() => reject(m.stop ? host.stop(m.error) : new Error(m.traceback ? `${m.error}\n${String(m.traceback).trim()}` : m.error)));
      };
      // The outcome is reported once the script has exited, so its own cleanup is over by then.
      const finish = (settle: () => void) => {
        const timer = setTimeout(() => { dispose(); settle(); }, EXIT_MS);
        onExit = () => { clearTimeout(timer); settle(); };
        if (!running()) onExit("");
      };
      send({ t: "start", args: api.args, budget: usage() });
    }).finally(dispose);
  }
}
