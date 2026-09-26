/** Types for workflow authors: `export default (async (api) => { ... }) satisfies Workflow;` */

export type JsonSchema = Record<string, unknown>;

export interface RunSpec {
  /** Named agent; omit for an ad-hoc subagent. */
  agent?: string;
  task: string;
  /** Ad-hoc subagents only: tool names to allow. */
  tools?: string[];
  /** Resolve to data matching this JSON Schema (or a property -> schema map) instead of text. */
  schema?: JsonSchema;
}

export interface WorkflowApi {
  run(spec: RunSpec & { schema: JsonSchema }): Promise<any>;
  run(spec: RunSpec): Promise<string>;
  run(agent: string, task: string): Promise<string>;
  /** Runs specs concurrently (up to maxConcurrency), in order; a run that fails becomes null. */
  all(specs: RunSpec[]): Promise<any[]>;
  /** Everything after the workflow name, as typed. */
  args: string;
  /** A progress line shown under the tool call. */
  log(message: string): void;
  /** Aborted on Ctrl-C; runs already check it. */
  signal: AbortSignal;
  /** Subagent tokens (prompt + completion) this run; run() throws once `total` is spent. */
  budget: { total: number | null; spent(): number; remaining(): number };
}

export type Workflow = (api: WorkflowApi) => unknown;
