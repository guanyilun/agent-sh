/**
 * Augments core's ShellEvents with the events agent-backend owns.
 * Any module consuming these must transitively import this file so
 * the declaration merge is visible.
 */

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
    "agent:register-backend": BackendRegistration;
    "config:switch-backend": { name: string };
    "config:list-backends": Record<string, never>;
    "config:get-backends": { names: string[]; active: string | null };

    "agent:identity": { identity: AgentIdentity | null };
    "agent:identity-changed": Record<string, never>;

    "agent:tools": { tools: import("../../agent/types.js").ToolDefinition[] };
    "agent:instructions": { instructions: Array<{ name: string; text: string }> };
    "agent:skills": { skills: Array<{ name: string; description: string; filePath: string }> };
  }
}

export {};
