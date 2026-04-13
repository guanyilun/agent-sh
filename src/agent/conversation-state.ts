import type { ChatCompletionMessageParam } from "../utils/llm-client.js";

/**
 * Manages the OpenAI chat messages array for the agent loop.
 * Separate from ContextManager — this is the LLM conversation,
 * not the shell history.
 *
 * Supports priority-based compaction: when the conversation exceeds the
 * token budget, low-priority turns are evicted to an archive that the
 * agent can search/expand via the conversation_recall tool.
 */

// ── Priority tiers (lower number = evicted first) ─────────────────

const enum Priority {
  /** Large read-only tool results (grep, ls, read_file) — agent can re-read. */
  LOWEST = 0,
  /** Successful tool results with no errors. */
  LOW = 1,
  /** Tool results from write/edit operations. */
  MEDIUM = 2,
  /** User messages, error messages, assistant reasoning. */
  HIGH = 3,
  /** First user message (original task) + last N turns — never evicted. */
  PINNED = 4,
}

/** Read-only tools whose results are cheap to reproduce. */
const READ_ONLY_TOOLS = new Set([
  "grep", "ls", "read_file", "glob", "bash", "search",
]);

/** Tools that produce durable changes — higher priority. */
const WRITE_TOOLS = new Set([
  "write_file", "edit_file", "write", "edit", "patch",
]);

/** An archived turn that was evicted from the active conversation. */
export interface EvictedTurn {
  id: number;
  messages: ChatCompletionMessageParam[];
  summary: string;
}

export class ConversationState {
  private messages: ChatCompletionMessageParam[] = [];
  private evicted: EvictedTurn[] = [];
  private nextTurnId = 1;

  addUserMessage(text: string): void {
    this.messages.push({ role: "user", content: text });
  }

  addAssistantMessage(
    content: string | null,
    toolCalls?: {
      id: string;
      function: { name: string; arguments: string };
    }[],
  ): void {
    if (toolCalls?.length) {
      this.messages.push({
        role: "assistant",
        content: content ?? null,
        tool_calls: toolCalls.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: tc.function,
        })),
      });
    } else {
      this.messages.push({ role: "assistant", content: content ?? "" });
    }
  }

  addToolResult(toolCallId: string, content: string): void {
    this.messages.push({
      role: "tool",
      tool_call_id: toolCallId,
      content,
    });
  }

  /** Inject a system-level note into the conversation (e.g. context change). */
  addSystemNote(text: string): void {
    this.messages.push({ role: "user", content: text });
  }

  getMessages(): ChatCompletionMessageParam[] {
    return this.messages;
  }

  // ── Compaction ──────────────────────────────────────────────────

  /**
   * Estimate token count for the current conversation.
   * Uses ~4 chars per token heuristic.
   */
  estimateTokens(): number {
    return Math.ceil(JSON.stringify(this.messages).length / 4);
  }

  /**
   * Priority-based compaction. Evicts lowest-priority turns until the
   * estimated token count is under the target budget.
   *
   * Pinned content (first user message + recent turns) is never evicted.
   */
  compact(targetTokens: number, recentTurnsToKeep = 10): void {
    if (this.estimateTokens() <= targetTokens) return;

    // Parse the message array into logical "turns" (boundaries at user messages)
    const turns = this.parseTurns();
    if (turns.length <= 2) return; // nothing to evict

    // Assign priorities — pin first turn and recent turns
    const pinnedCount = Math.min(recentTurnsToKeep, turns.length - 1);
    for (const turn of turns) {
      turn.priority = this.inferPriority(turn.messages);
    }
    turns[0]!.priority = Priority.PINNED; // original task
    for (let i = turns.length - pinnedCount; i < turns.length; i++) {
      turns[i]!.priority = Priority.PINNED;
    }

    // Build eviction candidates sorted by priority (lowest first), then oldest first
    const candidates = turns
      .map((t, idx) => ({ turn: t, idx }))
      .filter((c) => c.turn.priority !== Priority.PINNED)
      .sort((a, b) => a.turn.priority - b.turn.priority || a.idx - b.idx);

    // Evict until under budget
    const evictedIndices = new Set<number>();
    let currentTokens = this.estimateTokens();

    for (const c of candidates) {
      if (currentTokens <= targetTokens) break;
      const turnTokens = Math.ceil(JSON.stringify(c.turn.messages).length / 4);
      evictedIndices.add(c.idx);
      currentTokens -= turnTokens;

      // Archive the evicted turn
      this.evicted.push({
        id: this.nextTurnId++,
        messages: c.turn.messages,
        summary: this.summarizeTurn(c.turn.messages),
      });
    }

    if (evictedIndices.size === 0) return;

    // Rebuild messages: kept turns + compaction marker where evicted turns were
    const rebuilt: ChatCompletionMessageParam[] = [];
    let inEvictedRun = false;

    for (let i = 0; i < turns.length; i++) {
      if (evictedIndices.has(i)) {
        if (!inEvictedRun) {
          rebuilt.push({
            role: "user",
            content: `[Earlier conversation turns evicted for context space — use conversation_recall to search or expand]`,
          });
          inEvictedRun = true;
        }
      } else {
        inEvictedRun = false;
        rebuilt.push(...turns[i]!.messages);
      }
    }

    this.messages = rebuilt;
  }

  // ── Conversation recall (search / expand evicted turns) ────────

  /** Search evicted turns by regex/keyword. */
  search(query: string): string {
    if (!query.trim()) return "No query provided.";
    if (this.evicted.length === 0) return "No evicted turns to search.";

    let regex: RegExp;
    try {
      regex = new RegExp(query, "i");
    } catch {
      const words = query.split(/\s+/).filter((w) => w.length > 0);
      const pattern = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
      regex = new RegExp(pattern, "i");
    }

    const matches: { turn: EvictedTurn; excerpts: string[] }[] = [];

    for (const turn of this.evicted) {
      const text = this.turnToText(turn.messages);
      const lines = text.split("\n");
      const matchingLines: number[] = [];

      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i]!)) matchingLines.push(i);
      }

      if (matchingLines.length > 0) {
        const excerpts: string[] = [];
        for (const idx of matchingLines.slice(0, 5)) {
          const start = Math.max(0, idx - 2);
          const end = Math.min(lines.length, idx + 3);
          excerpts.push(lines.slice(start, end).join("\n"));
        }
        matches.push({ turn, excerpts });
      }
    }

    if (matches.length === 0) return `No results found for "${query}".`;

    const parts: string[] = [`Search results for "${query}" (${matches.length} turns):\n`];
    for (const m of matches.slice(0, 20)) {
      parts.push(`Turn #${m.turn.id}: ${m.turn.summary}`);
      for (const excerpt of m.excerpts) {
        parts.push("  " + excerpt.split("\n").join("\n  "));
      }
      parts.push("");
    }
    return parts.join("\n");
  }

  /** Expand the full content of an evicted turn by ID. */
  expand(turnId: number): string {
    const turn = this.evicted.find((t) => t.id === turnId);
    if (!turn) return `Turn #${turnId}: not found.`;
    return `Turn #${turnId}: ${turn.summary}\n\n${this.turnToText(turn.messages)}`;
  }

  /** Browse summaries of all evicted turns. */
  browse(): string {
    if (this.evicted.length === 0) return "No evicted conversation turns.";
    return this.evicted
      .map((t) => `#${t.id}: ${t.summary}`)
      .join("\n");
  }

  clear(): void {
    this.messages = [];
    this.evicted = [];
  }

  // ── Internal helpers ──────────────────────────────────────────

  private parseTurns(): { messages: ChatCompletionMessageParam[]; priority: Priority }[] {
    const turns: { messages: ChatCompletionMessageParam[]; priority: Priority }[] = [];
    let current: ChatCompletionMessageParam[] = [];

    for (const msg of this.messages) {
      // A user message starts a new turn (unless it's the very first message)
      if (msg.role === "user" && current.length > 0) {
        turns.push({ messages: current, priority: Priority.MEDIUM });
        current = [];
      }
      current.push(msg);
    }
    if (current.length > 0) {
      turns.push({ messages: current, priority: Priority.MEDIUM });
    }

    return turns;
  }

  private inferPriority(messages: ChatCompletionMessageParam[]): Priority {
    let hasError = false;
    let hasWriteTool = false;
    let allReadOnly = true;
    let hasToolResult = false;

    for (const msg of messages) {
      if (msg.role === "user") return Priority.HIGH;

      if (msg.role === "tool") {
        hasToolResult = true;
        const content = typeof msg.content === "string" ? msg.content : "";
        if (content.startsWith("Error:") || content.includes("error")) {
          hasError = true;
        }
      }

      if (msg.role === "assistant" && "tool_calls" in msg && msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          const fn = "function" in tc ? tc.function : undefined;
          if (!fn) continue;
          const name = fn.name;
          if (WRITE_TOOLS.has(name)) hasWriteTool = true;
          if (!READ_ONLY_TOOLS.has(name)) allReadOnly = false;
        }
      }
    }

    if (hasError) return Priority.HIGH;
    if (hasWriteTool) return Priority.MEDIUM;
    if (hasToolResult && allReadOnly) return Priority.LOWEST;
    if (hasToolResult) return Priority.LOW;
    return Priority.MEDIUM;
  }

  /** Generate a one-line heuristic summary of a turn (no LLM call). */
  private summarizeTurn(messages: ChatCompletionMessageParam[]): string {
    const parts: string[] = [];

    for (const msg of messages) {
      if (msg.role === "user" && typeof msg.content === "string") {
        parts.push(`user: ${msg.content.slice(0, 80)}`);
      }
      if (msg.role === "assistant") {
        if ("tool_calls" in msg && msg.tool_calls) {
          const tools = msg.tool_calls
            .map((tc) => "function" in tc ? tc.function.name : "unknown")
            .filter(Boolean);
          const unique = [...new Set(tools)];
          parts.push(`agent called ${unique.join(", ")}`);
        } else if (typeof msg.content === "string" && msg.content) {
          parts.push(`agent: ${msg.content.slice(0, 60)}...`);
        }
      }
    }

    return parts.join(" → ") || "(empty turn)";
  }

  /** Convert messages to a searchable text representation. */
  private turnToText(messages: ChatCompletionMessageParam[]): string {
    const lines: string[] = [];
    for (const msg of messages) {
      if (msg.role === "user") {
        lines.push(`[user] ${typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content)}`);
      } else if (msg.role === "assistant") {
        if (typeof msg.content === "string" && msg.content) {
          lines.push(`[assistant] ${msg.content}`);
        }
        if ("tool_calls" in msg && msg.tool_calls) {
          for (const tc of msg.tool_calls) {
            if ("function" in tc) {
              lines.push(`[tool_call] ${tc.function.name}(${tc.function.arguments.slice(0, 200)})`);
            }
          }
        }
      } else if (msg.role === "tool") {
        const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
        lines.push(`[tool_result] ${content.slice(0, 500)}`);
      }
    }
    return lines.join("\n");
  }
}
