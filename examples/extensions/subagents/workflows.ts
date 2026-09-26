import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { normalizeSchema, parseJsonReply, validate } from "./schema.js";
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
      if (!EXTS.includes(ext) || entry.endsWith(".d.ts")) continue;
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

export interface WorkflowDeps {
  runTask(spec: RunSpec, signal: AbortSignal, progress: (line: string) => void): Promise<string>;
  /** One-shot completion used to turn a subagent's answer into schema-shaped JSON. */
  complete(messages: { role: string; content: string }[]): Promise<string>;
  maxConcurrency: number;
  maxRuns: number;
}

export async function runWorkflow(
  def: WorkflowDef,
  args: string,
  deps: WorkflowDeps,
  signal: AbortSignal,
  progress: (line: string) => void,
): Promise<unknown> {
  // Import by content hash so edits load fresh and a trusted hash maps to what runs.
  const mod = await import(`${pathToFileURL(def.file).href}?v=${hashFile(def.file)}`);
  const fn = mod.default ?? mod.run;
  if (typeof fn !== "function") throw new Error(`${def.file} must export a default function`);

  const slots = new Semaphore(Math.max(1, deps.maxConcurrency));
  let runs = 0;

  const run = async (a: RunSpec | string, task?: string): Promise<any> => {
    const spec: RunSpec = typeof a === "string" ? { agent: a, task: task ?? "" } : a;
    if (!spec?.task) throw new Error("run() needs a task");
    if (++runs > deps.maxRuns) throw new Error(`workflow exceeded ${deps.maxRuns} subagent runs (subagents.maxRunsPerWorkflow)`);
    const label = `[${runs} ${spec.agent ?? "ad-hoc"}]`;
    await slots.acquire();
    try {
      if (signal.aborted) throw new Error("cancelled");
      const text = await deps.runTask(spec, signal, (line) => progress(`${label} ${line}`));
      if (!spec.schema) return text;
      return await extract(text, normalizeSchema(spec.schema), deps.complete);
    } finally {
      slots.release();
    }
  };

  const api: WorkflowApi = {
    run: run as WorkflowApi["run"],
    all: (specs) => Promise.all(specs.map(s => run(s))),
    args,
    log: (message) => progress(`· ${message}`),
    signal,
  };
  return await fn(api);
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

class Semaphore {
  private waiting: (() => void)[] = [];
  constructor(private free: number) {}

  acquire(): Promise<void> {
    if (this.free > 0) { this.free--; return Promise.resolve(); }
    return new Promise(resolve => this.waiting.push(resolve));
  }

  release(): void {
    const next = this.waiting.shift();
    if (next) next(); else this.free++;
  }
}

export function formatResult(value: unknown): string {
  if (value === undefined) return "(workflow finished without a result)";
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}
