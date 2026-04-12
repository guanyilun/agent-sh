import type { EventBus } from "../event-bus.js";

/**
 * Minimal agent backend interface — bus-driven.
 *
 * Backends self-wire to bus events in their constructor:
 *   - agent:submit → handle queries
 *   - agent:cancel-request → handle cancellation
 *   - config:cycle → handle mode switching
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

export interface ToolResult {
  content: string;
  exitCode: number | null;
  isError: boolean;
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
  kind: "read" | "write" | "execute" | "search" | "display";
  locations?: { path: string; line?: number | null }[];
  /** Custom icon character for TUI display (e.g., "◆", "⌕"). When set, the TUI shows
   *  icon + detail only. When absent, the tool name is shown alongside the detail. */
  icon?: string;
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
  ): Promise<ToolResult>;

  /** Whether to stream tool output to the TUI (default: true). */
  showOutput?: boolean;

  /** Whether this tool may modify files — triggers file watcher (default: false). */
  modifiesFiles?: boolean;

  /** Whether to gate execution via permission:request (default: false). */
  requiresPermission?: boolean;

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
}
