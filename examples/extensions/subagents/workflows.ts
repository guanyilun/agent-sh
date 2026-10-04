import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { normalizeSchema, parseJsonReply, validate } from "./schema.js";
import type { JournalEntry, RunDir } from "./runs.js";
import type { JsonSchema, RunOptions, RunSpec, WorkflowApi } from "./workflow-types.js";
import { ArgsError, helpText, parseArgs, tokenize, type ArgsSpec } from "./args.js";

const EXTS = [".ts", ".mts", ".js", ".mjs"];

export type WorkflowScope = "bundled" | "extension" | "user" | "project";

export interface WorkflowRegistration {
  name: string;
  file: string;
  description?: string;
}

export interface WorkflowDef {
  name: string;
  description: string;
  file: string;
  scope: WorkflowScope;
}

export function discoverWorkflows(dirs: { dir: string; scope: WorkflowScope }[]): Map<string, WorkflowDef> {
  const found = new Map<string, WorkflowDef>();
  for (const { dir, scope } of dirs) {
    let entries: string[];
    try { entries = fs.readdirSync(dir); } catch { continue; }
    for (const entry of entries.sort()) {
      const ext = path.extname(entry);
      if (!EXTS.includes(ext) || entry.endsWith(".d.ts") || entry.startsWith(".")) continue;
      const file = path.join(dir, entry);
      let source = "";
      try { source = fs.readFileSync(file, "utf8"); } catch { continue; }
      found.set(path.basename(entry, ext), { name: path.basename(entry, ext), description: staticDescription(source), file, scope });
    }
  }
  return found;
}

export function describeFile(file: string): string {
  try { return staticDescription(fs.readFileSync(file, "utf8")); } catch { return ""; }
}

// Read without importing: listing must never run an untrusted file.
function staticDescription(source: string): string {
  const m = source.match(/export\s+const\s+description\s*=\s*(["'`])([\s\S]*?)\1/);
  return m ? m[2]!.replace(/\s+/g, " ").trim() : "";
}

export function hashFile(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/** Project workflows run only after the user trusts that exact file content. */
export class TrustStore {
  constructor(private readonly file: string) {}

  isTrusted(def: WorkflowDef): boolean {
    if (def.scope !== "project") return true;
    return this.read()[def.file] === hashFile(def.file);
  }

  trust(def: WorkflowDef): void {
    const entries = this.read();
    entries[def.file] = hashFile(def.file);
    fs.writeFileSync(this.file, JSON.stringify(entries, null, 2));
  }

  private read(): Record<string, string> {
    try { return JSON.parse(fs.readFileSync(this.file, "utf8")); } catch { return {}; }
  }
}

export interface TaskControl {
  signal: AbortSignal;
  progress(line: string): void;
  onUsage(totalTokens: number): void;
  onMessage(message: Record<string, unknown>): void;
  /** Once it has a concurrency slot. */
  onStart?(): void;
  /** agent() turns: the conversation to continue, and where to hand back the updated one. */
  history?: unknown[];
  onHistory?(messages: unknown[]): void;
}

export interface TaskResult {
  text: string;
  value?: unknown;
}

export interface WorkflowDeps {
  runTask(spec: RunSpec, ctl: TaskControl): Promise<TaskResult>;
  /** Extraction to the schema when the agent answers in text instead of submitting. */
  complete(messages: { role: string; content: string }[]): Promise<string>;
  maxRuns: number;
}

export interface WorkflowRunOpts {
  run: RunDir;
  replay?: JournalEntry[];
  budgetTokens?: number;
  module?: Record<string, unknown>;
  quietMs?: number;
}

/** Ends the whole workflow; all() rethrows it instead of returning null. */
export class WorkflowStop extends Error {}
/** A race() item stopped because another one won. */
class Cancelled extends Error {}
const stops = (err: unknown) => err instanceof WorkflowStop || err instanceof Cancelled;
export { ArgsError, helpText } from "./args.js";

export async function runWorkflow(
  def: WorkflowDef,
  args: string | string[],
  deps: WorkflowDeps,
  signal: AbortSignal,
  progress: (line: string) => void,
  opts: WorkflowRunOpts,
): Promise<unknown> {
  const { run: record } = opts;
  const counts = { queued: 0, working: 0, done: 0 };
  const started = Date.now();
  let lastLine = started;
  const say = progress;
  progress = (line) => { lastLine = Date.now(); say(line); };
  const quiet = opts.quietMs && setInterval(() => {
    if (Date.now() - lastLine < opts.quietMs! || !counts.queued && !counts.working) return;
    progress(`· ${counts.working} working, ${counts.queued} queued, ${counts.done} finished; ${Math.round((Date.now() - started) / 60_000)} min, ${record.record.tokens} tokens`);
  }, Math.min(opts.quietMs, 10_000));
  if (quiet) quiet.unref();
  try {
    const mod = opts.module ?? await importFresh(def);
    const fn = mod.default ?? mod.run;
    if (typeof fn !== "function") throw new Error(`${def.file} must export a default function`);
    const apiArgs = workflowArgs(def, mod, args);

    // Calls are identified by position (each map/pipeline item numbers its own); old journals replay by call order.
    const entries = opts.replay ?? [];
    const legacy = entries.length > 0 && entries.every(e => e.id === undefined);
    const replay = new Map(entries.map(e => [legacy ? String(e.seq) : e.id, e]));
    const scopes = new AsyncLocalStorage<Scope>();
    const root: Scope = { path: "", next: 0, diverged: false, signal };
    const scope = () => scopes.getStore() ?? root;
    const inItem = <R>(k: number, i: number, fn: () => R, cancel?: AbortSignal): R => {
      const parent = scope();
      return scopes.run({
        path: `${parent.path}${k}.${i}/`, next: 0, diverged: false, parent,
        signal: cancel ? AbortSignal.any([parent.signal, cancel]) : parent.signal,
      }, fn);
    };
    let reused = 0;
    let runs = 0;
    const total = opts.budgetTokens && opts.budgetTokens > 0 ? opts.budgetTokens : null;
    const spent = () => record.record.tokens;
    const budget = { total, spent, remaining: () => (total === null ? Infinity : Math.max(0, total - spent())) };

    // seq is taken synchronously on call, so the same script calls run() in the same order on replay.
    const run = async (a: RunSpec | string | null, task?: string, options?: RunOptions): Promise<any> => {
      const at = scope();
      return exec(toSpec(a, task, options), ++runs, at, `${at.path}${++at.next}`);
    };

    const exec = async (spec: RunSpec, seq: number, at: Scope, id: string, chat?: Chat): Promise<any> => {
      if (!spec.task) throw new Error("run() needs a task");
      if (seq > deps.maxRuns) throw new WorkflowStop(`workflow exceeded ${deps.maxRuns} subagent runs (subagents.maxRunsPerWorkflow)`);
      if (spec.system && spec.agent) throw new Error(`run(): "system" is for ad-hoc runs; ${spec.agent} has its own prompt`);
      const label = `[${seq} ${spec.label ?? spec.agent ?? "ad-hoc"}]`;
      // A turn's key covers the turns before it.
      const key = chat ? createHash("sha256").update(chat.key + specKey(spec)).digest("hex").slice(0, 16) : specKey(spec);

      const cached = isDiverged(at) ? undefined : replay.get(legacy ? String(seq) : id);
      if (cached && cached.key === key) {
        reused++;
        record.append({ ...cached, seq, id });
        if (chat) { chat.key = key; chat.history.push(...cached.added ?? []); }
        progress(`${label} reused from ${record.record.resumedFrom}`);
        return cached.output;
      }
      if (cached) {
        // Later calls in this branch may depend on this one, so they run live too.
        (legacy ? root : at).diverged = true;
        progress(`· replay stopped at run ${seq}: its inputs changed; ${reused} run(s) reused`);
      }

      if (signal.aborted) throw new WorkflowStop("cancelled");
      if (at.signal.aborted) throw new Cancelled("cancelled");
      if (budget.remaining() <= 0) throw new WorkflowStop(`token budget of ${total} exhausted`);

      const write = record.transcript(seq);
      write({ type: "start", agent: spec.agent, task: spec.task, schema: spec.schema });
      let tokens = 0;
      let state: "queued" | "working" = "queued";
      let history: unknown[] | undefined;
      counts.queued++;
      try {
        const result = await deps.runTask(spec, {
          signal: at.signal,
          ...(chat && { history: chat.history, onHistory: (m: unknown[]) => { history = m; } }),
          onStart: () => {
            if (state === "working") return;
            state = "working"; counts.queued--; counts.working++;
            write({ type: "running" });
            progress(`${label} started`);
          },
          progress: (line) => progress(`${label} ${line}`),
          onUsage: (t) => { tokens += t; record.record.tokens += t; },
          onMessage: (m) => write({ type: "message", ...m }),
        });
        // An aborted subagent returns its partial text; that's a stop, not a result.
        if (signal.aborted) throw new WorkflowStop("cancelled");
        if (at.signal.aborted) throw new Cancelled("cancelled");
        const output = !spec.schema ? result.text
          : result.value !== undefined ? result.value
          : await extract(result.text, normalizeSchema(spec.schema), deps.complete);
        const added = chat && history ? history.slice(chat.history.length) : undefined;
        record.append({ seq, id, key, agent: spec.agent, output, tokens, ...(added && { added }) });
        if (chat) { chat.key = key; if (history) chat.history = history; }
        write({ type: "end", ok: true, tokens });
        return output;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        write({ type: "end", ok: false, error: message, tokens });
        const lost = at.signal.aborted && !signal.aborted;
        progress(lost ? `${label} cancelled` : `${label} failed: ${message}`);
        throw signal.aborted ? new WorkflowStop("cancelled") : lost ? new Cancelled("cancelled") : err;
      } finally {
        counts[state]--;
        counts.done++;
      }
    };

    const api: WorkflowApi = {
      run: run as WorkflowApi["run"],
      agent: (name, base) => {
        const at = scope();
        const sid = `${at.path}${++at.next}`;
        const chat: Chat = { key: "", history: [] };
        let turns = 0;
        let last: Promise<unknown> = Promise.resolve();
        return {
          // Position and number are taken on call; the turn itself waits for the one before it.
          ask: (task, options) => {
            const spec = toSpec(name, task, { ...base, ...options });
            const seq = ++runs;
            const here = scope();
            const id = `${sid}:${++turns}`;
            const turn = last.then(() => exec(spec, seq, here, id, chat));
            last = turn.catch(() => {});
            return turn;
          },
        };
      },
      race: async (items, fn, accept) => {
        const at = scope();
        const k = ++at.next;
        const id = `${at.path}${k}`;
        const key = `race:${items.length}`;
        const attempt = (i: number, cancel?: AbortSignal) => inItem(k, i, async () => {
          const value = await fn(items[i]!, i);
          return { value, ok: !accept || !!(await accept(value, items[i]!, i)) };
        }, cancel);
        const failed = (i: number, err: unknown) => {
          if (err instanceof WorkflowStop) throw err;
          if (!(err instanceof Cancelled)) progress(`· race item ${i + 1} failed: ${err instanceof Error ? err.message : String(err)}`);
        };

        // On resume only the recorded winner runs; if it no longer passes, the others race.
        const cached = isDiverged(at) ? undefined : replay.get(id);
        let tried: number | undefined;
        if (cached?.winner !== undefined && cached.key === key) {
          tried = cached.winner;
          try {
            const r = await attempt(tried);
            if (r.ok) { record.append({ ...cached, seq: runs }); return { value: r.value, index: tried }; }
          } catch (err) { failed(tried, err); }
        }

        const cancels = items.map(() => new AbortController());
        let won: { value: any; index: number } | null = null;
        await Promise.all(items.map(async (_, i) => {
          if (i === tried) return;
          try {
            const r = await attempt(i, cancels[i]!.signal);
            if (!r.ok || won) return;
            won = { value: r.value, index: i };
            cancels.forEach((c, j) => { if (j !== i) c.abort(); });
          } catch (err) { failed(i, err); }
        }));
        if (won) record.append({ seq: runs, id, key, winner: (won as { index: number }).index, output: null, tokens: 0 });
        return won;
      },
      all: (specs) => Promise.all(specs.map(s => run(s).catch((err) => {
        if (stops(err)) throw err;
        return null;
      }))),
      map: (items, fn) => {
        const k = ++scope().next;
        return Promise.all(items.map((item, i) => inItem(k, i, async () => {
          try {
            return await fn(item, i);
          } catch (err) {
            if (stops(err)) throw err;
            progress(`· map item ${i + 1} failed: ${err instanceof Error ? err.message : String(err)}`);
            return null;
          }
        })));
      },
      pipeline: (items: unknown[], ...stages: ((prev: any, item: any, index: number) => unknown)[]) => {
        const k = ++scope().next;
        return Promise.all(items.map((item, i) => inItem(k, i, async () => {
          let value: unknown = item;
          for (const [n, stage] of stages.entries()) {
            try {
              value = await stage(value, item, i);
            } catch (err) {
              if (stops(err)) throw err;
              progress(`· pipeline item ${i + 1} failed at stage ${n + 1}: ${err instanceof Error ? err.message : String(err)}`);
              return null;
            }
          }
          return value;
        })));
      },
      args: apiArgs,
      log: (message) => progress(`· ${message}`),
      signal,
      budget,
    };
    const result = await fn(api);
    record.finish("done");
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    record.finish(signal.aborted ? "cancelled" : "failed", message);
    throw err;
  } finally {
    if (quiet) clearInterval(quiet);
  }
}

// Fresh hidden .mts/.mjs copy per load: loaders cache by path, and tsx loads untyped .ts/.js as CommonJS.
async function importFresh(def: WorkflowDef): Promise<Record<string, unknown>> {
  const source = fs.readFileSync(def.file);
  const hash = createHash("sha256").update(source).digest("hex");
  const ext = /\.m?ts$/.test(def.file) ? ".mts" : ".mjs";
  const copy = path.join(path.dirname(def.file), `.${def.name}.${hash.slice(0, 12)}.${randomBytes(3).toString("hex")}${ext}`);
  try {
    fs.writeFileSync(copy, source);
  } catch {
    return import(`${pathToFileURL(def.file).href}?v=${hash}`);
  }
  try {
    return await import(pathToFileURL(copy).href);
  } finally {
    fs.rmSync(copy, { force: true });
  }
}

export function workflowArgs(def: WorkflowDef, mod: Record<string, unknown>, args: string | string[]): any {
  const spec = mod.args as ArgsSpec | undefined;
  if (!spec || typeof spec !== "object") return Array.isArray(args) ? args.join(" ") : args;
  try {
    return parseArgs(spec, Array.isArray(args) ? args : tokenize(args));
  } catch (err) {
    if (!(err instanceof ArgsError)) throw err;
    throw new ArgsError(`${err.message}\n\n${helpText(path.basename(def.file), spec, mod.description as string | undefined)}`);
  }
}

function toSpec(a: RunSpec | string | null, task?: string, options?: RunOptions): RunSpec {
  const spec: RunSpec = typeof a === "string" || a === null || a === undefined
    ? { ...options, agent: a ?? undefined, task: task ?? "" }
    : { ...a };
  if (spec.returns !== undefined && spec.schema === undefined) spec.schema = spec.returns;
  delete spec.returns;
  spec.task = dedent(String(spec.task ?? ""));
  return spec;
}

export function dedent(text: string): string {
  const lines = text.replace(/^[ \t]*\n/, "").replace(/\n[ \t]*$/, "").split("\n");
  const indent = lines.find((l) => l.trim())?.match(/^[ \t]*/)![0] ?? "";
  return indent ? lines.map((l) => (l.startsWith(indent) ? l.slice(indent.length) : l)).join("\n") : lines.join("\n");
}

interface Scope { path: string; next: number; diverged: boolean; parent?: Scope; signal: AbortSignal }
/** An agent() conversation: the last turn's key and the messages so far. */
interface Chat { key: string; history: unknown[] }
const isDiverged = (s: Scope | undefined): boolean => !!s && (s.diverged || isDiverged(s.parent));

function specKey(spec: RunSpec): string {
  const inputs = [spec.agent ?? null, spec.task, spec.tools ?? null, spec.schema ?? null];
  // Added later; only included when set, so older journals still match.
  for (const k of ["system", "model", "thinking"] as const) if (spec[k] !== undefined) inputs.push(`${k}:${spec[k]}`);
  return createHash("sha256").update(JSON.stringify(inputs)).digest("hex").slice(0, 16);
}

async function extract(
  text: string,
  schema: JsonSchema,
  complete: WorkflowDeps["complete"],
): Promise<unknown> {
  const messages = [
    {
      role: "system",
      content: "Convert the text into JSON matching the JSON Schema, using only what the text says. Reply with the JSON value only.",
    },
    { role: "user", content: `JSON Schema:\n${JSON.stringify(schema)}\n\nText:\n${text}` },
  ];
  let problem = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const reply = await complete(messages);
    try {
      const value = parseJsonReply(reply);
      problem = validate(value, schema) ?? "";
      if (!problem) return value;
    } catch (err) {
      problem = err instanceof Error ? err.message : String(err);
    }
    messages.push({ role: "assistant", content: reply }, { role: "user", content: `Invalid: ${problem}. Reply with corrected JSON only.` });
  }
  throw new Error(`could not get output matching the schema: ${problem}`);
}

export function formatResult(value: unknown): string {
  if (value === undefined) return "(workflow finished without a result)";
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}
