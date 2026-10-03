/** Types for workflow authors: `export default (async (api) => { ... }) satisfies Workflow;` */

export type JsonSchema = Record<string, unknown>;

export interface RunOptions {
  /** Shape shorthand or JSON Schema; the run then resolves to validated data. */
  returns?: JsonSchema | string;
  /** Same as `returns` (older name). */
  schema?: JsonSchema | string;
  /** Ad-hoc subagents only: tool names to allow ([] for none). */
  tools?: string[];
  /** Ad-hoc subagents only: the system prompt (its role and rules); the task is the message. */
  system?: string;
  model?: string;
  thinking?: string;
  label?: string;
}

export interface RunSpec extends RunOptions {
  /** Named agent; omit for an ad-hoc subagent. */
  agent?: string;
  task: string;
}

export interface WorkflowApi {
  run(agent: string | null, task: string, options?: RunOptions): Promise<any>;
  run(spec: RunSpec): Promise<any>;
  /** A failed item becomes null. */
  map<T, R>(items: T[], fn: (item: T, index: number) => Promise<R>): Promise<(R | null)[]>;
  /** Items move through the stages independently; a stage that throws makes its item null. */
  pipeline<T>(items: T[], ...stages: ((prev: any, item: T, index: number) => unknown)[]): Promise<any[]>;
  /** Runs specs concurrently (up to maxConcurrency), in order; a run that fails becomes null. */
  all(specs: RunSpec[]): Promise<any[]>;
  args: any;
  log(message: string): void;
  signal: AbortSignal;
  /** Subagent tokens (prompt + completion) this run; run() throws once `total` is spent. */
  budget: { total: number | null; spent(): number; remaining(): number };
}

export type Workflow = (api: WorkflowApi) => unknown;
