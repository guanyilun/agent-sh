/** Compatibility API for focused runs on the shared ash engine. */
import type { BusEvents, EventBus } from "../core/event-bus.js";
import type { ChatCompletionMessageParam, LlmClient } from "./llm-client.js";
import type { ToolDefinition } from "./types.js";
import type { AgentRunOptions } from "./run-contract.js";
import { createAgentHost, ashEngine } from "../runtime/index.js";

export interface SubagentOptions {
  /** LLM client to use. */
  llmClient: LlmClient;
  /** Working directory (defaults to process.cwd() for standalone callers). */
  cwd?: string;
  /** Tools available to the subagent. */
  tools: ToolDefinition[];
  /** System prompt for this subagent. */
  systemPrompt: string;
  /** The task to perform. */
  task: string;
  /** Model override (optional, defaults to llmClient's model). */
  model?: string;
  /** Event bus for TUI events (optional — silent if omitted). */
  bus?: EventBus;
  /** Abort signal for cancellation. */
  signal?: AbortSignal;
  /** Max tool loop iterations (default 20). */
  maxIterations?: number;
  /**
   * Ambient context rebuilt per iteration, same shape the parent's
   * streamResponse uses. If provided, the subagent sees budget,
   * metacognitive signals, in-flight siblings, etc.
   */
  dynamicContext?: string;
  /**
   * Per-subagent completion-token budget. When the cumulative
   * completion_tokens across iterations exceeds this, the subagent
   * terminates gracefully on the next iteration. We deliberately don't
   * count prompt tokens: the full history is resent each iteration, so
   * prompt-inclusive counting double-charges context and makes a budget
   * of N exhaust after O(log N) tool calls. Completion tokens measure
   * the work the subagent actually produces. The parent's daily budget
   * still sees real prompt+completion via onUsage.
   */
  budgetTokens?: number;
  /**
   * Invoked after every streamed LLM response with its usage totals.
   * The parent uses this to forward to its event bus so global budget
   * tracking stays accurate.
   */
  onUsage?: (usage: SubagentUsage) => void;
  reasoningParams?: Record<string, unknown>;
  outMeta?: SubagentRunMeta;
  /** Each message as it joins the subagent's conversation, e.g. for a transcript. */
  onMessage?: (message: SubagentMessage) => void;
  /** Checked after each round of tool calls; returning true ends the run. */
  shouldStop?: () => boolean;
  /** An earlier run's `outMeta.messages`; the task continues that conversation. */
  history?: ChatCompletionMessageParam[];
}

export interface SubagentUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  /** The part of prompt_tokens the provider served from its cache, when it says. */
  cached_tokens?: number;
}

export interface SubagentMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  toolCalls?: { name: string; arguments: string }[];
  toolName?: string;
  isError?: boolean;
}

export interface SubagentRunMeta {
  degraded?: "budget" | "iterations" | null;
  tokensUsed?: number;
  mutatingToolExecuted?: boolean;
  /** The conversation so far, to pass as the next run's `history`. */
  messages?: ChatCompletionMessageParam[];
}

/** Run a focused, append-only conversation using the full agent engine. */
export async function runSubagent(opts: SubagentOptions): Promise<string> {
  const { llmClient, model, outMeta, bus, maxIterations = 20 } = opts;
  if (outMeta) {
    outMeta.degraded = null;
    outMeta.tokensUsed = 0;
    outMeta.mutatingToolExecuted = false;
  }
  // Real clients own their configuration; lightweight test clients need not fork.
  const client = typeof llmClient.fork === "function"
    ? llmClient.fork(model ? { model } : {})
    : llmClient;
  const host = await createAgentHost({
    cwd: opts.cwd ?? process.cwd(),
    settings: { autoCompact: false, toolMode: "api" },
    extensions: [ashEngine({
      client,
      model: { id: model ?? client.model, provider: "custom", echoReasoning: true },
      // The client already owns credentials; this endpoint only supplies the
      // legacy OpenAI-shaped usage decoder, including cache accounting.
      endpoint: {
        apiKey: "",
        extractCachedTokens: usage => (usage.prompt_tokens_details as { cached_tokens?: number } | undefined)?.cached_tokens ?? 0,
      },
      tools: opts.tools,
    })],
  });
  const childBus = host.context.bus;
  const unsubscribers: (() => void)[] = [];
  let lastText = "";
  try {
    // Never share the parent's bus: lifecycle, usage and steering belong to the
    // child. Only the legacy rendering events cross this optional boundary.
    if (bus) {
      const forward = <K extends "agent:tool-started" | "agent:tool-output-chunk" | "agent:tool-completed">(name: K) => {
        const listener = (payload: BusEvents[K]) => {
          if (name === "agent:tool-completed") bus.emitTransform(name, payload);
          else bus.emit(name, payload);
        };
        childBus.on(name, listener);
        unsubscribers.push(() => childBus.off(name, listener));
      };
      forward("agent:tool-started");
      forward("agent:tool-output-chunk");
      forward("agent:tool-completed");
    }
    const runOptions: AgentRunOptions = {
      systemPrompt: opts.systemPrompt,
      history: opts.history,
      signal: opts.signal,
      maxIterations,
      budgetTokens: opts.budgetTokens,
      reasoningParams: opts.reasoningParams,
      dynamicContext: opts.dynamicContext,
      onUsage: opts.onUsage,
      onMessage: (message: SubagentMessage) => {
        if (message.role === "assistant" && message.content) lastText = message.content;
        opts.onMessage?.(message.role === "assistant"
          ? { ...message, toolCalls: message.toolCalls }
          : message);
      },
      shouldStop: opts.shouldStop,
      toolScheduling: "sequential" as const,
      // Compatibility callers expect thrown tools to fail the run and provider
      // errors without the interactive engine's provider/model decoration.
      throwToolErrors: true,
      rawErrors: true,
    };
    const result = await host.run(opts.task, runOptions);
    const details = result.details;
    if (!details) throw new Error("Subagent engine returned no run details");
    const degraded = details.stopReason === "limited" && (details.limit === "budget" || details.limit === "iterations")
      ? details.limit : null;
    if (outMeta) {
      outMeta.degraded = degraded;
      outMeta.tokensUsed = details.usage.completion_tokens;
      outMeta.mutatingToolExecuted = details.mutatingToolExecuted;
      outMeta.messages = details.messages;
    }
    if (details.stopReason === "failed") throw new Error(details.error ?? result.error ?? "Subagent run failed");
    const text = details.finalText || lastText;
    if (degraded === "budget") {
      return text + `\n\n[Subagent terminated: completion-token budget (${opts.budgetTokens}) exhausted after ${details.usage.completion_tokens} completion tokens. Returning partial progress.]`;
    }
    if (degraded === "iterations") {
      return text + `\n\n[Subagent terminated: max iterations (${maxIterations}) reached. Returning partial progress.]`;
    }
    return text;
  } finally {
    for (const unsubscribe of unsubscribers) unsubscribe();
    await host.dispose();
  }
}
