import type { ChatCompletionMessageParam } from "./llm-client.js";
import type { ImageContent, ToolDefinition, ToolExecutionContext, ToolResult } from "./types.js";

/** Wire history, without the per-request system/dynamic-context envelope. */
export interface AgentSnapshot {
  version: 1;
  messages: ChatCompletionMessageParam[];
}

/** Structurally compatible with SubagentMessage. */
export interface AgentRunMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  toolCalls?: { id?: string; name: string; arguments: string }[];
  toolName?: string;
  isError?: boolean;
  /** Tool results: the id of the call they answer. */
  callId?: string;
}

export interface AgentRunUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cached_tokens?: number;
  /** Per-response only (onUsage): why the stream ended, and its timing. */
  finish_reason?: string;
  duration_ms?: number;
  first_token_ms?: number;
}

export interface AgentRunOptions {
  runId?: string;
  images?: ImageContent[];
  systemPrompt?: string;
  /** A string, or a function re-evaluated before every model call (a live signal for long runs). */
  dynamicContext?: string | (() => string);
  /** Replaces this engine's history before appending query; defensively copied. */
  history?: ChatCompletionMessageParam[];
  /** Maximum LLM rounds (retries do not count). Unlimited by default. */
  maxIterations?: number;
  /** Cumulative completion-token budget, not prompt tokens. Unlimited by default.
   * Checked between rounds; each request is capped to the remaining budget. */
  budgetTokens?: number;
  signal?: AbortSignal;
  /** Checked after a complete tool batch has been recorded. */
  shouldStop?: () => boolean | Promise<boolean>;
  onMessage?: (message: AgentRunMessage) => void;
  /** Per-response usage, not cumulative usage. */
  onUsage?: (usage: AgentRunUsage) => void;
  reasoningParams?: Record<string, unknown>;
  /** Sequential model order is useful for control tools and compatibility runs. */
  toolScheduling?: "parallel-readonly" | "sequential";
  /** Fail the run on a thrown tool error instead of recording a tool result. */
  throwToolErrors?: boolean;
  /** Preserve the original failure message in result.error (legacy adapters). */
  rawErrors?: boolean;
  /** Keep retrying a transient model-call failure (a cut stream, a network error, 429/5xx) for this long from the
   *  first failure, instead of giving up after the fixed few attempts.  The run's conversation is in memory, so a
   *  long unattended run (a workflow's subagent) rides out an endpoint outage without losing its earlier steps. */
  retryWindowMs?: number;
  /** Apply retryWindowMs from the run's first call too.  By default a call before the run's first response gets only
   *  the fixed few attempts (nothing is lost yet, and a caller may move to another model); a caller that never
   *  changes model (an unattended workflow on one provider) rides out an outage that starts before it. */
  retryFirstCall?: boolean;
  /** Treat a model call that sends nothing at all for this long as a transient failure (retried like a cut stream).
   *  An unreachable backend otherwise holds the call until the transport's own long timeout (35-46 min seen). */
  firstByteTimeoutMs?: number;
}

/** Named handler agent:run accepts this single object.
 * agent:steer-active(text: string): boolean queues input only while this engine
 * can still consume it in the active run (including its startup reservation).
 * It returns false when idle, cancelled or completing, and never starts a run.
 */
export interface AgentRunInput extends AgentRunOptions {
  query: string;
}

export interface AgentRunResult {
  runId: string;
  stopReason: "completed" | "cancelled" | "limited" | "failed";
  limit?: "iterations" | "budget" | "shouldStop";
  /** All assistant text in this run; finalText is just the latest round. */
  text: string;
  finalText: string;
  usage: AgentRunUsage;
  iterations: number;
  messages: ChatCompletionMessageParam[];
  /** True once a modifiesFiles tool reaches dispatch, including failed attempts. */
  mutatingToolExecuted: boolean;
  error?: string;
}

/** tool:dispatch sits inside the tool:execute policy wrapper. The default calls
 * the registry's tool:<name> handler, preserving per-tool advice. */
export interface AgentToolDispatchInput {
  name: string;
  args: Record<string, unknown>;
  tool: ToolDefinition;
  onChunk?: (chunk: string) => void;
  context: ToolExecutionContext;
}
export type AgentToolDispatcher = (input: AgentToolDispatchInput) => Promise<ToolResult>;
