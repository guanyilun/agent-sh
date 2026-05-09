import type { EventBus, ContentBlock } from "./event-bus.js";
import type { ColorPalette } from "./utils/palette.js";
import type { BlockTransformOptions, FencedBlockTransformOptions } from "./utils/stream-transform.js";
import type { ToolDefinition } from "./agent/types.js";
import type { Compositor } from "./utils/compositor.js";
import type { HistoryAdapter } from "./agent/history-file.js";

export type { ContentBlock } from "./event-bus.js";
export type { BlockTransformOptions, FencedBlockTransformOptions } from "./utils/stream-transform.js";
export type { RenderSurface } from "./utils/compositor.js";

// ── Remote sessions ──────────────────────────────────────────────

export interface RemoteSessionOptions {
  /** The surface to render agent output to. */
  surface: import("./utils/compositor.js").RenderSurface;
  /** Suppress response borders (default: true). */
  suppressBorders?: boolean;
  /** Suppress user query box (default: false).
   *  True for sessions with their own input (rsplit, overlay).
   *  False for sessions where input comes from the main shell (split). */
  suppressQueryBox?: boolean;
  /** Suppress usage stats line (default: true). */
  suppressUsage?: boolean;
}

export interface RemoteSession {
  /** Submit a query to the agent from this session. */
  submit(query: string): void;
  /** The surface this session renders to. */
  readonly surface: import("./utils/compositor.js").RenderSurface;
  /** Whether this session is currently active. */
  readonly active: boolean;
  /** Tear down — restores all routing and advisors. */
  close(): void;
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

/**
 * Backend-agnostic LLM interface exposed via `ctx.llm`. Backends fulfill it
 * by defining an `llm:invoke` handler; those without an LLM leave
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

export interface AgentShellConfig {
  shell?: string;
  model?: string;
  extensions?: string[];

  // ── LLM provider ─────────────────────────────────────────────
  /** API key for OpenAI-compatible provider. */
  apiKey?: string;
  /** Base URL for OpenAI-compatible API. */
  baseURL?: string;
  /** Named provider to use from settings.json. */
  provider?: string;

  /** Override settings.defaultBackend for this session only (does not persist). */
  backend?: string;

  /** Conversation history backend. Defaults to the on-disk HistoryFile. */
  history?: HistoryAdapter;
}

/**
 * Context passed to user/third-party extensions.
 * Extensions interact with the system through the event bus — no direct
 * frontend (Shell/TUI) dependencies. This enables headless, web, or
 * alternative frontends without changing extensions.
 */
export interface ExtensionContext {
  bus: EventBus;
  /** Stable per-instance identifier (4-char hex). */
  readonly instanceId: string;
  quit: () => void;
  /** Override color palette slots for theming. */
  setPalette: (overrides: Partial<ColorPalette>) => void;

  // ── Stream transform utilities ─────────────────────────────
  /** Register a delimiter-based content transform (e.g. $$...$$ → image). */
  createBlockTransform: (opts: BlockTransformOptions) => void;
  /** Register a fenced block transform (e.g. ```lang...``` → code-block). */
  createFencedBlockTransform: (opts: FencedBlockTransformOptions) => void;
  /** Read extension-namespaced settings from ~/.agent-sh/settings.json. */
  getExtensionSettings: <T extends Record<string, unknown>>(namespace: string, defaults: T) => T;

  /**
   * Get (and lazily create) a per-extension storage directory under
   * ~/.agent-sh/<namespace>/. Returns the absolute path. Lets extensions
   * persist state without each one re-deriving the location.
   */
  getStoragePath: (namespace: string) => string;

  // ── Slash command registration ─────────────────────────────
  /** Register a slash command available in any input mode. */
  registerCommand: (name: string, description: string, handler: (args: string) => Promise<void> | void) => void;

  // ── Tool registration (agent-sh backend only) ─────────────
  /** Register a tool for the built-in agent. No-op when using bridge backends. */
  registerTool: (tool: ToolDefinition) => void;
  /** Unregister a tool by name. */
  unregisterTool: (name: string) => void;
  /** Get all registered tools (for subagent tool subsets). Returns [] when using bridge backends. */
  getTools: () => ToolDefinition[];

  // ── System prompt instructions ────────────────────────────
  /** Register a named instruction block for the agent's system prompt. */
  registerInstruction: (name: string, text: string) => void;
  /** Remove a named instruction block from the system prompt. */
  removeInstruction: (name: string) => void;

  // ── Skill registration ────────────────────────────────────
  /** Register a skill (on-demand reference material) for the agent. */
  registerSkill: (name: string, description: string, filePath: string) => void;
  /** Remove a registered skill by name. */
  removeSkill: (name: string) => void;

  // ── Dynamic context registration ──────────────────────────
  /**
   * Register a context producer — a function that contributes a string
   * (or `null` to skip) into one of two lifecycles:
   *
   * - `mode: "per-request"` (default) — fires on **every LLM request**,
   *   including each tool-loop iteration. Output is ephemerally wrapped
   *   in `<dynamic_context>` onto the trailing message at request time;
   *   never persisted. Use for "current state" signals (in-flight work,
   *   active mode, threshold warnings).
   *
   * - `mode: "per-query"` — fires **once at user-query start** in
   *   handleQuery. Output is wrapped in `<query_context>` and frozen into
   *   the user message; persists in conversation history. Use for
   *   "what happened between turns" signals (shell events, accumulated
   *   notifications, calendar/inbox deltas).
   *
   * In both modes producers run in registration order, non-null outputs
   * joined with blank lines. When nothing contributes, no envelope tag
   * is emitted.
   *
   * Returns a dispose fn that unregisters the producer.
   */
  registerContextProducer: (
    name: string,
    producer: () => string | null,
    opts?: { mode?: "per-request" | "per-query" },
  ) => () => void;

  // ── Provider configuration ────────────────────────────────
  providers: {
    configure: (id: string, opts: { reasoningParams?: (level: string, model?: string) => Record<string, unknown> }) => void;
  };

  // ── LLM access (backend-agnostic) ─────────────────────────
  llm: LlmInterface;

  // ── Named handler registry (Emacs-style advice) ───────────
  /** Register a named handler. */
  define: (name: string, fn: (...args: any[]) => any) => void;
  /** Wrap a named handler. Receives `next` (original) + args. Returns an unadvise function. */
  advise: (name: string, wrapper: (next: (...args: any[]) => any, ...args: any[]) => any) => () => void;
  /** Call a named handler. */
  call: (name: string, ...args: any[]) => any;
  /** Names of all registered handlers — for diagnostic / introspection use. */
  list: () => string[];

  // Note: a `terminal-buffer` handler is registered by the shell frontend
  // (src/shell/), returning an xterm.js mirror of PTY output. Extensions
  // can read it via `ctx.call("terminal-buffer")`; the call returns null
  // only when no shell frontend is loaded (e.g. under a hub or web bridge).

  // ── Compositor ─────────────────────────────────────────────────
  /**
   * Routes named render streams ("agent", "query", "status") to surfaces.
   * Extensions use `compositor.redirect()` to capture output (e.g. overlay panels).
   */
  compositor: Compositor;

  // ── Lifecycle ──────────────────────────────────────────────────
  /** Teardown callback fired on /reload. For resources the scoped context
   *  can't track: process listeners, timers, watchers, sockets. */
  onDispose: (fn: () => void) => void;

  // ── Remote sessions ────────────────────────────────────────────
  /**
   * Create a remote session that routes agent output to a surface and
   * optionally accepts queries. Handles all compositor routing, shell
   * lifecycle advisors, and chrome suppression.
   *
   *   const session = ctx.createRemoteSession({ surface });
   *   session.submit("what's on screen?");
   *   session.close();  // restores everything
   */
  createRemoteSession: (opts: RemoteSessionOptions) => RemoteSession;
}

/**
 * Configuration for a registered input mode.
 * Extensions emit "input-mode:register" with this shape to add new modes.
 */
export interface InputModeConfig {
  id: string;              // unique identifier, e.g. "agent", "translate"
  trigger: string;         // single char trigger at empty line start: "?", ">"
  label: string;           // human-readable label shown in prompt
  promptIcon: string;      // the chevron/icon character, e.g. "❯", "⟩"
  indicator: string;       // status indicator shown before the icon, e.g. "❓", "●"
  onSubmit(query: string, bus: EventBus): void;
  returnToSelf: boolean;   // re-enter this mode after agent processing?
}

export interface TerminalSession {
  id: string;
  command: string;
  output: string;
  exitCode: number | null;
  done: boolean;
  resolve?: (value: void) => void;
}
