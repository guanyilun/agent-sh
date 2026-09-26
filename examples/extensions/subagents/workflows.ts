import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { normalizeSchema, parseJsonReply, validate } from "./schema.js";
import type { JournalEntry, RunDir } from "./runs.js";
import type { JsonSchema, RunSpec, WorkflowApi } from "./workflow-types.js";

const EXTS = [".ts", ".mts", ".js", ".mjs"];

export type WorkflowScope = "bundled" | "user" | "project";

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
}

/** Ends the whole workflow; all() rethrows it instead of returning null. */
export class WorkflowStop extends Error {}

export async function runWorkflow(
  def: WorkflowDef,
  args: string,
  deps: WorkflowDeps,
  signal: AbortSignal,
  progress: (line: string) => void,
  opts: WorkflowRunOpts,
): Promise<unknown> {
  const { run: record } = opts;
  try {
    const mod = await importFresh(def);
    const fn = mod.default ?? mod.run;
    if (typeof fn !== "function") throw new Error(`${def.file} must export a default function`);

    const replay = new Map((opts.replay ?? []).map(e => [e.seq, e]));
    let diverged = false;
    let reused = 0;
    let runs = 0;
    const total = opts.budgetTokens && opts.budgetTokens > 0 ? opts.budgetTokens : null;
    const spent = () => record.record.tokens;
    const budget = { total, spent, remaining: () => (total === null ? Infinity : Math.max(0, total - spent())) };

    // seq is taken synchronously on call, so the same script calls run() in the same order on replay.
    const run = async (a: RunSpec | string, task?: string): Promise<any> => {
      const seq = ++runs;
      const spec: RunSpec = typeof a === "string" ? { agent: a, task: task ?? "" } : a;
      if (!spec?.task) throw new Error("run() needs a task");
      if (seq > deps.maxRuns) throw new WorkflowStop(`workflow exceeded ${deps.maxRuns} subagent runs (subagents.maxRunsPerWorkflow)`);
      const label = `[${seq} ${spec.agent ?? "ad-hoc"}]`;
      const key = specKey(spec);

      const cached = diverged ? undefined : replay.get(seq);
      if (cached && cached.key === key) {
        reused++;
        record.append(cached);
        progress(`${label} reused from ${record.record.resumedFrom}`);
        return cached.output;
      }
      if (cached) {
        diverged = true;
        progress(`· replay stopped at run ${seq}: its inputs changed; ${reused} run(s) reused`);
      }

      if (signal.aborted) throw new WorkflowStop("cancelled");
      if (budget.remaining() <= 0) throw new WorkflowStop(`token budget of ${total} exhausted`);

      const write = record.transcript(seq);
      write({ type: "start", agent: spec.agent, task: spec.task, schema: spec.schema });
      let tokens = 0;
      try {
        const result = await deps.runTask(spec, {
          signal,
          progress: (line) => progress(`${label} ${line}`),
          onUsage: (t) => { tokens += t; record.record.tokens += t; },
          onMessage: (m) => write({ type: "message", ...m }),
        });
        const output = !spec.schema ? result.text
          : result.value !== undefined ? result.value
          : await extract(result.text, normalizeSchema(spec.schema), deps.complete);
        record.append({ seq, key, agent: spec.agent, output, tokens });
        write({ type: "end", ok: true, tokens });
        return output;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        write({ type: "end", ok: false, error: message, tokens });
        progress(`${label} failed: ${message}`);
        throw signal.aborted ? new WorkflowStop("cancelled") : err;
      }
    };

    const api: WorkflowApi = {
      run: run as WorkflowApi["run"],
      all: (specs) => Promise.all(specs.map(s => run(s).catch((err) => {
        if (err instanceof WorkflowStop) throw err;
        return null;
      }))),
      args,
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
  }
}

// Loaders can cache a module by path and ignore ?query (tsx's CommonJS route, Node 20), so an
// edited workflow could run stale. Import an exact copy under a new hidden name beside the
// original: same module mode and relative imports, and exactly the bytes hashed. The query
// stays too; without it tsx on Node 20 takes a require() route that rejects ESM files.
async function importFresh(def: WorkflowDef): Promise<Record<string, unknown>> {
  const source = fs.readFileSync(def.file);
  const hash = createHash("sha256").update(source).digest("hex");
  const ext = path.extname(def.file);
  const copy = path.join(path.dirname(def.file), `.${def.name}.${hash.slice(0, 12)}.${randomBytes(3).toString("hex")}${ext}`);
  try {
    fs.writeFileSync(copy, source);
  } catch {
    return import(`${pathToFileURL(def.file).href}?v=${hash}`);
  }
  try {
    return await import(`${pathToFileURL(copy).href}?v=${hash}`);
  } finally {
    fs.rmSync(copy, { force: true });
  }
}

function specKey(spec: RunSpec): string {
  const inputs = [spec.agent ?? null, spec.task, spec.tools ?? null, spec.schema ?? null];
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
