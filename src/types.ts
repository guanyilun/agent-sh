export interface AgentShellConfig {
  agentCommand: string;
  agentArgs: string[];
  shell: string;
  model?: string; // Model name extracted from agent args
}

export interface TerminalSession {
  id: string;
  command: string;
  output: string;
  exitCode: number | null;
  done: boolean;
  resolve?: (value: void) => void;
}

// ── Exchange types (used by ContextManager) ──────────────────────

export interface ToolCallRecord {
  tool: string;
  args: Record<string, unknown>;
  output: string;
  exitCode: number | null;
}

export type Exchange =
  | {
      type: "shell_command";
      id: number;
      timestamp: number;
      cwd: string;
      command: string;
      output: string;
      exitCode: number | null;
      outputLines: number;
      outputBytes: number;
    }
  | {
      type: "agent_query";
      id: number;
      timestamp: number;
      query: string;
    }
  | {
      type: "agent_response";
      id: number;
      timestamp: number;
      response: string;
      toolCalls: ToolCallRecord[];
    }
  | {
      type: "tool_execution";
      id: number;
      timestamp: number;
      tool: string;
      args: Record<string, unknown>;
      output: string;
      exitCode: number | null;
      outputLines: number;
      outputBytes: number;
    };
