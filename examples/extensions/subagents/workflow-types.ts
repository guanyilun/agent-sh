/** Types for workflow authors: `export default (async (api) => { ... }) satisfies Workflow;` */

export type JsonSchema = Record<string, unknown>;

export interface RunOptions {
  /** Shape shorthand or JSON Schema; the run then resolves to validated data. */
  returns?: JsonSchema | string;
  /** Same as `returns` (older name). */
  schema?: JsonSchema | string;
  /** Ad-hoc subagents only: tool names to allow ([] for none). */
  tools?: string[];
  /** Ad-hoc subagents only: the system prompt. */
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

export interface AgentHandle {
  /** The next turn of the same conversation; one runs at a time. */
  ask(task: string, options?: RunOptions): Promise<any>;
}

export interface WorkflowApi {
  run(agent: string | null, task: string, options?: RunOptions): Promise<any>;
  run(spec: RunSpec): Promise<any>;
  /** Keeps its conversation between ask() calls; `options` apply to every turn. */
  agent(agent: string | null, options?: RunOptions): AgentHandle;
  /** The first result that passes `accept` wins and the other items are cancelled; null if none does. */
  race<T, R>(items: T[], fn: (item: T, index: number) => Promise<R>, accept?: (value: R, item: T, index: number) => unknown): Promise<{ value: R; index: number } | null>;
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
