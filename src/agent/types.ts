import type { EventBus } from "../core/event-bus.js";

/**
 * Minimal agent backend interface — bus-driven.
 *
 * Backends self-wire to bus events in their constructor:
 *   - agent:submit → handle queries
 *   - agent:cancel-request → handle cancellation
 *
 * They emit bus events for results:
 *   - agent:response-chunk, agent:tool-started, agent:tool-completed, etc.
 *
 * The only imperative method is kill() for lifecycle cleanup.
 */
export interface AgentBackend {
  /** Async startup (e.g. spawn subprocess). No-op if not needed. */
  start?(): Promise<void>;
  kill(): void;
}

/** Image content block for multimodal tool results. */
export interface ImageContent {
  type: "image";
  /** Base64-encoded image data (no data: URL prefix). */
  data: string;
  /** MIME type (e.g. "image/png", "image/jpeg"). */
  mimeType: string;
}

/** Extract the text portion of a tool result's content. Returns "" for image-only results. */
export function contentText(content: string | ImageContent[]): string {
  if (typeof content === "string") return content;
  return content.map(c => `[image: ${c.mimeType}]`).join("\n");
}

export interface ToolResult {
  content: string | ImageContent[];
  exitCode: number | null;
  isError: boolean;
  /** When set, takes precedence over `tool.formatResult()`. */
  display?: ToolResultDisplay;
}

/** Structured result display — returned by formatResult or computed by defaults. */
export interface ToolResultDisplay {
  /** One-line summary shown next to ✓/✗ (e.g. "42 papers found", "+3/-1"). */
  summary?: string;
  /** Structured content to render below the status line. */
  body?: ToolResultBody;
}

export type ToolResultBody =
  | { kind: "diff"; diff: unknown; filePath: string }
  | { kind: "lines"; lines: string[]; maxLines?: number }

export interface ToolDisplayInfo {
  /** Verb shown next to the detail (e.g. "execute foo.py"). Omit when a custom
   *  `icon` already makes the action self-evident — the renderer then shows
   *  icon + detail with no verb. */
  kind?: "read" | "write" | "execute" | "search";
  locations?: { path: string; line?: number | null }[];
  /** Custom icon character for TUI display (e.g., "◆", "⌕"). When set, the TUI shows
   *  icon + detail only. When absent, the tool name is shown alongside the detail. */
  icon?: string;
  /** highlight.js-style language identifier ("scheme", "python", …) for
   *  renderers that syntax-highlight tool source. Omit for plain text. */
  sourceLanguage?: string;
}

/** Interactive UI session — imperative control over rendering + input. */
export interface InteractiveSession<T> {
  /** Return lines to render. Called on mount and after each input. */
  render(width: number): string[];
  /** Handle raw input. Call done(result) to finish the session. */
  handleInput(data: string, done: (result: T) => void): void;
  /** done() lets the session resolve itself from outside handleInput. */
  onMount?(invalidate: () => void, done: (result: T) => void): void;
  /** Called when session ends (cleanup). */
  onUnmount?(): void;
}

/** Interactive UI capability passed to tools during execution. */
export interface ToolUI {
  /** Present a custom interactive UI and wait for the user's response. */
  custom<T>(session: InteractiveSession<T>): Promise<T>;
}

/** Context passed to tool execute() as optional third parameter. */
export interface ToolExecutionContext {
  ui?: ToolUI;
  /** Aborted on Ctrl-C — tools with subprocess work should listen and clean up. */
  signal?: AbortSignal;
}

/** LLM-facing view of a tool — what `adviseToolSchema` advisors return. */
export interface ToolSchemaView {
  description: string;
  parameters: Record<string, unknown>;
}

/** LLM-facing view of a skill — what `adviseSkill` advisors return. */
export interface SkillView {
  description: string;
  filePath: string;
}

export interface ToolDefinition {
  name: string;
  /** Short label for TUI display (e.g. "search" instead of "ads_search"). Defaults to name. */
  displayName?: string;
  description: string;
  input_schema: Record<string, unknown>;

  execute(
    args: Record<string, unknown>,
    onChunk?: (chunk: string) => void,
    ctx?: ToolExecutionContext,
  ): Promise<ToolResult>;

  /** Whether to stream tool output to the TUI (default: true). */
  showOutput?: boolean;

  /** Whether this tool may modify files — triggers file watcher (default: false). */
  modifiesFiles?: boolean;

  /** Results are re-fetchable; nuclear compaction drops the tool_result
   *  body on eviction (like the builtin read_file/grep/ls). Default: false. */
  readOnly?: boolean;

  /** Derive display metadata (icon kind, file paths) for the TUI. */
  getDisplayInfo?: (args: Record<string, unknown>) => ToolDisplayInfo;

  /**
   * Format a short display string for the TUI when this tool is called.
   * Return a concise summary of the args (e.g. the query, the file path).
   * When absent, the TUI derives the detail from common arg fields (command, path, pattern).
   */
  formatCall?: (args: Record<string, unknown>) => string;

  /**
   * Format result display for the TUI after execution completes.
   * Return a summary string and/or structured body to render.
   * When absent, defaults are computed based on tool kind.
   * Extensions can further override via bus.onPipe("agent:tool-completed", ...).
   */
  formatResult?: (args: Record<string, unknown>, result: ToolResult) => ToolResultDisplay;

  /** Override the agent-loop's per-tool-result truncation cap (default 16 KB).
   *  Use for tools that bundle multiple operations and legitimately produce
   *  larger output (interpreter substrates etc.). */
  maxResultBytes?: number;
}
