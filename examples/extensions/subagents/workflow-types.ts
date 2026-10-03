/** Types for workflow authors: `export default (async (api) => { ... }) satisfies Workflow;` */

export type JsonSchema = Record<string, unknown>;

export interface RunOptions {
  /** Resolve to data of this shape instead of text: shorthand like { verdict: "clean | issues", findings: "string[]" }, or JSON Schema. */
  returns?: JsonSchema | string;
  /** Same as `returns` (older name). */
  schema?: JsonSchema | string;
  /** Ad-hoc subagents only: tool names to allow ([] for none). */
  tools?: string[];
  /** Ad-hoc subagents only: the system prompt (its role and rules); the task is the message. */
  system?: string;
  /** Model id for this run, overriding the agent's and the run's. */
  model?: string;
  /** Reasoning effort for this run: off, low, medium, high. */
  thinking?: string;
  /** Shown in progress lines instead of the agent name, e.g. [3 proofreader]. */
  label?: string;
}

export interface RunSpec extends RunOptions {
  /** Named agent; omit for an ad-hoc subagent. */
  agent?: string;
  task: string;
}

export interface WorkflowApi {
  /** run("reviewer", task) → text; run("reviewer", task, { returns }) → data; run(null, task) → ad-hoc subagent. */
  run(agent: string | null, task: string, options?: RunOptions): Promise<any>;
  run(spec: RunSpec): Promise<any>;
  /** Calls fn for each item concurrently (up to maxConcurrency); results in order, a failed item becomes null. */
  map<T, R>(items: T[], fn: (item: T, index: number) => Promise<R>): Promise<(R | null)[]>;
  /** Sends each item through the stages on its own (no waiting between stages); a stage that throws makes the item null. */
  pipeline<T>(items: T[], ...stages: ((prev: any, item: T, index: number) => unknown)[]): Promise<any[]>;
  /** Runs specs concurrently (up to maxConcurrency), in order; a run that fails becomes null. */
  all(specs: RunSpec[]): Promise<any[]>;
  /** With `export const args = {...}`: the parsed arguments. Otherwise everything after the file name, as text. */
  args: any;
  /** A progress line shown under the tool call (stderr under `agent-sh run`). */
  log(message: string): void;
  /** Aborted on Ctrl-C or at the deadline; runs already check it. */
  signal: AbortSignal;
  /** Subagent tokens (prompt + completion) this run; run() throws once `total` is spent. */
  budget: { total: number | null; spent(): number; remaining(): number };
}

export type Workflow = (api: WorkflowApi) => unknown;
