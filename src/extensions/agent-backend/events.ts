/**
 * Augments core's ShellEvents with the events agent-backend owns.
 * Any module consuming these must transitively import this file so
 * the declaration merge is visible.
 */
import type { ContentBlock } from "../../core/event-bus.js";
import type { ToolResultDisplay } from "../../agent/types.js";

/** Stable identity of whichever backend is currently active. */
export interface AgentIdentity {
  name: string;
  version: string;
  model?: string;
  provider?: string;
  contextWindow?: number;
}

/** Registration payload backends use to enroll themselves. */
export interface BackendRegistration {
  name: string;
  kill: () => void;
  start?: () => Promise<void>;
}

declare module "../../core/event-bus.js" {
  interface ShellEvents {
    // ── Registry / lifecycle ──────────────────────────────────────
    "agent:register-backend": BackendRegistration;
    "config:switch-backend": { name: string };
    "config:list-backends": Record<string, never>;
    "config:get-backends": { names: string[]; active: string | null };

    // ── Identity (active backend emits on start + on changes) ────
    "agent:info": AgentIdentity;

    // ── Capability registration (pull-composition) ────────────────
    "agent:tools": { tools: import("../../agent/types.js").ToolDefinition[] };
    "agent:instructions": { instructions: Array<{ name: string; text: string }> };
    "agent:skills": { skills: Array<{ name: string; description: string; filePath: string }> };

    // ── User → backend ────────────────────────────────────────────
    "agent:submit": { query: string };
    "agent:cancel-request": { silent?: boolean };
    "agent:append-user-message": { text: string };
    "agent:query": { query: string };
    "agent:reset-session": Record<string, never>;
    "agent:compact-request": Record<string, never>;

    // ── Backend → UI: response stream ────────────────────────────
    "agent:thinking-chunk": { text: string };
    "agent:response-chunk": { blocks: ContentBlock[] };
    "agent:response-done": { response: string };
    "agent:usage": { prompt_tokens: number; completion_tokens: number; total_tokens: number };

    // ── Backend → UI: lifecycle ──────────────────────────────────
    "agent:processing-start": Record<string, never>;
    "agent:processing-done": Record<string, never>;
    "agent:cancelled": Record<string, never>;
    "agent:error": { message: string };

    // ── Backend → UI: tool execution ─────────────────────────────
    "agent:tool-call": { tool: string; args: Record<string, unknown> };
    "agent:tool-output": {
      tool: string;
      output: string;
      exitCode: number | null;
    };
    "agent:tool-batch": {
      groups: Array<{
        kind: string;
        tools: Array<{ name: string; displayDetail?: string }>;
      }>;
    };
    "agent:tool-batch-complete": {
      results: Array<{ name: string; isError: boolean; errorSummary?: string }>;
    };
    "agent:tool-started": {
      title: string;
      toolCallId?: string;
      kind?: string;
      icon?: string;
      locations?: { path: string; line?: number | null }[];
      rawInput?: unknown;
      /** Pre-formatted display detail from tool's formatCall(). */
      displayDetail?: string;
      /** highlight.js-style identifier for syntax-highlighting `rawInput.source`. */
      sourceLanguage?: string;
      batchIndex?: number;
      batchTotal?: number;
    };
    "agent:tool-completed": {
      toolCallId?: string;
      exitCode: number | null;
      rawOutput?: unknown;
      kind?: string;
      /** Structured result display — set by formatResult or defaults, overridable via onPipe. */
      resultDisplay?: ToolResultDisplay;
    };
    "agent:tool-output-chunk": { chunk: string };

    // ── Tool taking over rendering/input ─────────────────────────
    "tool:interactive-start": Record<string, never>;
    "tool:interactive-end": Record<string, never>;

    // ── Subagent lifecycle ───────────────────────────────────────
    "agent:subagent-started": { taskId: string; task: string };
    "agent:subagent-completed": { taskId: string; task: string; result: string; isError: boolean };

    // ── Terminal interception (sync pipe: extensions intercept before exec)
    "agent:terminal-intercept": {
      command: string;
      cwd: string;
      intercepted: boolean;
      output: string;
    };

    // ── Conversation lifecycle (any backend that has a conversation)
    "conversation:message-appended": {
      role: "user" | "assistant" | "tool" | "system";
      content: string;
      /** For role="tool": name of the tool whose result this is. */
      toolName?: string;
      /** For role="tool": parsed arguments passed to the tool. */
      toolArgs?: Record<string, unknown>;
      /** For role="tool": whether the tool errored. */
      isError?: boolean;
    };
    "conversation:after-compact": {
      beforeTokens: number;
      afterTokens: number;
      evictedCount: number;
    };

    // ── Context / compaction (any backend with a context budget) ──
    "context:get-stats": {
      activeTokens: number;
      totalTokens: number;
      budgetTokens: number;
    };
    "context:snapshot": {
      messages: unknown[];
      contextWindow: number;
      activeTokens: number;
    };
    "context:compact": {
      strategy?:
        | { kind: "two-tier-pin"; target: number; keepRecent?: number; force?: boolean }
        | { kind: "rewind"; toIndex: number }
        | { kind: "replace"; messages: unknown[] };
      stats?: { before: number; after: number; evictedCount: number };
    };

    // ── User-facing model/thinking control (UI → active backend) ──
    "config:switch-model": { model: string };
    "config:get-models": { models: { model: string; provider: string }[]; active: { model: string; provider: string } | null };
    "config:set-thinking": { level: string };
    "config:get-thinking": { level: string; levels: string[]; supported: boolean };
  }
}

export {};
