/** Events agent-backend owns. Consumers must transitively import this file. */
import type { ContentBlock } from "../../core/event-bus.js";
import type { ToolResultDisplay } from "../../agent/types.js";

export interface AgentIdentity {
  name: string;
  version: string;
  model?: string;
  provider?: string;
  contextWindow?: number;
}

export interface BackendRegistration {
  name: string;
  kill: () => void;
  start?: () => Promise<void>;
}

declare module "../../core/event-bus.js" {
  interface BusEvents {
    "agent:register-backend": BackendRegistration;
    "config:switch-backend": { name: string };
    "config:list-backends": Record<string, never>;
    "config:get-backends": { names: string[]; active: string | null };

    "agent:info": AgentIdentity;

    "agent:tools": { tools: import("../../agent/types.js").ToolDefinition[] };
    "agent:instructions": { instructions: Array<{ name: string; text: string }> };
    "agent:skills": { skills: Array<{ name: string; description: string; filePath: string }> };

    "agent:submit": { query: string };
    "agent:cancel-request": { silent?: boolean };
    "agent:append-user-message": { text: string };
    "agent:query": { query: string };
    "agent:reset-session": Record<string, never>;
    "agent:compact-request": Record<string, never>;

    "agent:thinking-chunk": { text: string };
    "agent:response-chunk": { blocks: ContentBlock[] };
    "agent:response-done": { response: string };
    "agent:usage": { prompt_tokens: number; completion_tokens: number; total_tokens: number };

    "agent:processing-start": Record<string, never>;
    "agent:processing-done": Record<string, never>;
    "agent:cancelled": Record<string, never>;
    "agent:error": { message: string };

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
      displayDetail?: string;
      /** highlight.js identifier for rawInput.source. */
      sourceLanguage?: string;
      batchIndex?: number;
      batchTotal?: number;
    };
    "agent:tool-completed": {
      toolCallId?: string;
      exitCode: number | null;
      rawOutput?: unknown;
      kind?: string;
      resultDisplay?: ToolResultDisplay;
    };
    "agent:tool-output-chunk": { chunk: string };

    "tool:interactive-start": Record<string, never>;
    "tool:interactive-end": Record<string, never>;

    "agent:subagent-started": { taskId: string; task: string };
    "agent:subagent-completed": { taskId: string; task: string; result: string; isError: boolean };

    "agent:terminal-intercept": {
      command: string;
      cwd: string;
      intercepted: boolean;
      output: string;
    };

    "conversation:message-appended": {
      role: "user" | "assistant" | "tool" | "system";
      content: string;
      toolName?: string;
      toolArgs?: Record<string, unknown>;
      isError?: boolean;
    };
    "conversation:after-compact": {
      beforeTokens: number;
      afterTokens: number;
      evictedCount: number;
    };

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

    "config:switch-model": { model: string };
    "config:get-models": { models: { model: string; provider: string }[]; active: { model: string; provider: string } | null };
    "config:set-thinking": { level: string };
    "config:get-thinking": { level: string; levels: string[]; supported: boolean };
  }
}

export {};
