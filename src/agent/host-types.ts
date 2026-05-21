import type { CoreConfig, CoreContext } from "../core/types.js";
import type { HistoryAdapter } from "./history-file.js";
import type { SkillView, ToolDefinition, ToolExecutionContext, ToolSchemaView } from "./types.js";

// ── LLM port ─────────────────────────────────────────────────────

/**
 * Backend-agnostic LLM interface exposed via `ctx.agent.llm`. Fulfilled
 * by defining an `llm:invoke` handler; backends without an LLM leave
 * `available` false and calls reject.
 */
export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmSession {
  send(message: string): Promise<string>;
  history(): ReadonlyArray<LlmMessage>;
}

export interface LlmInterface {
  readonly available: boolean;
  /** `model` overrides the globally-configured model for this call only.
   *  Provider-specific identifier (e.g. "claude-haiku-4-5"). When omitted,
   *  the active provider's configured default is used.
   *
   *  `reasoningEffort` controls thinking-model token allocation between
   *  reasoning and final content (e.g. "low", "medium", "high", or
   *  provider-specific). For non-reasoning models it is ignored. Set to
   *  "low" for cheap structured-output calls so reasoning doesn't exhaust
   *  the max-tokens budget and leave content empty. */
  ask(opts: {
    query: string;
    system?: string;
    maxTokens?: number;
    model?: string;
    reasoningEffort?: string;
  }): Promise<string>;
  session(opts?: {
    system?: string;
    maxTokens?: number;
    model?: string;
    reasoningEffort?: string;
  }): LlmSession;
}

export interface ProviderRegistration {
  id: string;
  apiKey?: string;
  baseURL?: string;
  /** Falls back to models[0] when absent. */
  defaultModel?: string;
  models?: (string | { id: string; reasoning?: boolean; contextWindow?: number; maxTokens?: number; echoReasoning?: boolean })[];
  supportsReasoningEffort?: boolean;
  /** Local daemons etc. — `auth list/login` shows "no auth required". */
  noAuth?: boolean;
}

/** A model entry in the cycling list, optionally tied to a provider. */
export interface AgentMode {
  model: string;
  /** Provider id — when cycling changes provider, LlmClient is reconfigured. */
  provider?: string;
  /** Provider-specific config for reconfiguring LlmClient on switch. */
  providerConfig?: { apiKey: string; baseURL?: string };
  /** Context window size in tokens (for usage display). */
  contextWindow?: number;
  /** Max output tokens for this mode. */
  maxTokens?: number;
  /** Model supports reasoning/thinking tokens. */
  reasoning?: boolean;
  /** Provider supports the reasoning_effort parameter. */
  supportsReasoningEffort?: boolean;
  /** Echo reasoning_content back on assistant turns. Required by DeepSeek;
   *  default off (leaky shims may forward it to the model as OOD input). */
  echoReasoning?: boolean;
  buildReasoningParams?: (level: string) => Record<string, unknown>;
}

// ── Agent-host extension surface ─────────────────────────────────

/**
 * Capabilities the agent host adds on top of CoreContext. Only available
 * when the built-in agent backend is loaded; bridge backends pass a bare
 * CoreContext, so extensions that need these should type as AgentContext.
 */
export interface AgentSurface {
  llm: LlmInterface;
  providers: {
    /** Re-registering the same id replaces the prior contribution. */
    register: (reg: ProviderRegistration) => () => void;
    unregister: (id: string) => void;
    configure: (id: string, opts: { reasoningParams?: (level: string, model?: string) => Record<string, unknown> }) => void;
  };

  // ── Tool registration ────────────────────────────────────────
  registerTool: (tool: ToolDefinition) => void;
  unregisterTool: (name: string) => void;
  adviseTool: (
    name: string,
    advisor: (
      next: ToolDefinition["execute"],
      args: Record<string, unknown>,
      onChunk?: (chunk: string) => void,
      ctx?: ToolExecutionContext,
    ) => ReturnType<ToolDefinition["execute"]>,
  ) => () => void;
  adviseToolSchema: (
    name: string,
    advisor: (next: () => ToolSchemaView) => ToolSchemaView,
  ) => () => void;
  getTools: () => ToolDefinition[];

  // ── System prompt instructions ──────────────────────────────
  registerInstruction: (name: string, text: string) => void;
  removeInstruction: (name: string) => void;
  adviseInstruction: (
    name: string,
    advisor: (next: () => string) => string,
  ) => () => void;

  // ── Skill registration ──────────────────────────────────────
  registerSkill: (name: string, description: string, filePath: string) => void;
  removeSkill: (name: string) => void;
  adviseSkill: (
    name: string,
    advisor: (next: () => SkillView) => SkillView,
  ) => () => void;

  // ── Dynamic context registration ────────────────────────────
  /**
   * Register a context producer — a function that contributes a string
   * (or `null` to skip) into one of two lifecycles:
   *
   * - `mode: "per-request"` (default) — fires on every LLM request,
   *   including each tool-loop iteration. Output is ephemerally wrapped
   *   in `<dynamic_context>` onto the trailing message at request time;
   *   never persisted. Use for "current state" signals.
   *
   * - `mode: "per-query"` — fires once at user-query start. Output is
   *   wrapped in `<query_context>` and frozen into the user message;
   *   persists in conversation history.
   *
   * Returns a dispose fn that unregisters the producer.
   */
  registerContextProducer: (
    name: string,
    producer: () => string | null,
    opts?: { mode?: "per-request" | "per-query" },
  ) => () => void;
}

/** Substrate + agent surface. Use this when an extension only touches
 *  agent-side features (tools, instructions, LLM) and doesn't need
 *  shell rendering. */
export type AgentContext = CoreContext & { agent: AgentSurface };

// ── Agent-host config surface ────────────────────────────────────

export interface AgentConfigSurface {
  /** API key for OpenAI-compatible provider. */
  apiKey?: string;
  /** Base URL for OpenAI-compatible API. */
  baseURL?: string;
  /** Named provider to use from settings.json. */
  provider?: string;
  /** Default model id. */
  model?: string;
  /** Conversation history backend. Defaults to the on-disk HistoryFile. */
  history?: HistoryAdapter;
}

export type AgentConfig = CoreConfig & AgentConfigSurface;
