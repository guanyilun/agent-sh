import type { ChatCompletionMessageParam } from "../utils/llm-client.js";

// ── Compact result ───────────────────────────────────────────────
// Generic, strategy-agnostic return shape for the `conversation:compact`
// handler. Strategies may return richer data as extended fields; the
// core `conversation:after-compact` event only carries these three.

export interface CompactResult {
  /** Token estimate before compaction. */
  before: number;
  /** Token estimate after compaction. */
  after: number;
  /** Number of turns evicted. */
  evictedCount: number;
  /** Strategies may attach additional arbitrary fields. */
  [extra: string]: unknown;
}

/**
 * Conversation state — plain message-ops plus token estimation.
 *
 * Owns the messages array, the cached JSON for token counting, and a
 * running baseline from API responses. Everything richer (persistent
 * history, compaction strategies, recall / search) lives in extensions
 * via the `conversation:message-appended` event and the
 * `conversation:compact` / `conversation:replace-messages` handlers.
 */
export class ConversationState {
  private messages: ChatCompletionMessageParam[] = [];
  /** Dirty flag — invalidated on every mutation to this.messages. */
  private messagesDirty = true;
  /** Cached JSON.stringify of messages (lazily computed, invalidated on mutation). */
  private cachedMessagesJson: string | null = null;

  /** Last known token count from the API (prompt_tokens). null until first response. */
  private lastApiTokenCount: number | null = null;
  /** Number of messages in the array when lastApiTokenCount was recorded. */
  private lastApiMessageCount: number = 0;

  /** Get JSON.stringify of messages, cached until next mutation. */
  private getMessagesJson(): string {
    if (this.messagesDirty || this.cachedMessagesJson === null) {
      this.cachedMessagesJson = JSON.stringify(this.messages);
      this.messagesDirty = false;
    }
    return this.cachedMessagesJson;
  }

  /** Mark messages as mutated — invalidates the JSON cache. */
  private invalidateMessagesCache(): void {
    this.messagesDirty = true;
    this.cachedMessagesJson = null;
  }

  // ── Message API ───────────────────────────────────────────────

  addUserMessage(text: string): void {
    this.messages.push({ role: "user", content: text });
    this.invalidateMessagesCache();
  }

  addAssistantMessage(
    content: string | null,
    toolCalls?: { id: string; function: { name: string; arguments: string } }[],
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
    this.invalidateMessagesCache();
  }

  addToolResult(toolCallId: string, content: string): void {
    this.messages.push({ role: "tool", tool_call_id: toolCallId, content });
    this.invalidateMessagesCache();
  }

  /** Add tool results as a user message (for inline tool protocol). */
  addToolResultInline(content: string): void {
    this.messages.push({ role: "user", content });
    this.invalidateMessagesCache();
  }

  addSystemNote(text: string): void {
    this.messages.push({ role: "user", content: text });
    this.invalidateMessagesCache();
  }

  getMessages(): ChatCompletionMessageParam[] {
    return this.messages;
  }

  /**
   * Replace the entire messages array — the write side of custom
   * compaction strategies. Extensions implementing `conversation:compact`
   * read messages, compute a shorter array, and call this to install it.
   */
  replaceMessages(messages: ChatCompletionMessageParam[]): void {
    this.messages = messages;
    this.invalidateMessagesCache();
    this.lastApiTokenCount = null;
    this.lastApiMessageCount = 0;
  }

  // ── Token estimation ──────────────────────────────────────────

  /**
   * Update the token count baseline from an API response.
   * `promptTokens` is the total input tokens (system prompt + context + messages).
   */
  updateApiTokenCount(promptTokens: number): void {
    this.lastApiTokenCount = promptTokens;
    this.lastApiMessageCount = this.messages.length;
  }

  /**
   * Estimate total tokens the next API call will consume.
   *
   * Includes system prompt, dynamic context, tool definitions, and
   * conversation messages. When API usage data is available, it uses
   * the real prompt_tokens as a baseline and only estimates the delta
   * for messages added since. Falls back to chars/4 if no API data yet.
   */
  estimatePromptTokens(): number {
    if (this.lastApiTokenCount === null) {
      return this.estimateTokens();
    }
    const trailing = this.messages.length - this.lastApiMessageCount;
    if (trailing <= 0) {
      return this.lastApiTokenCount;
    }
    const trailingMessages = this.messages.slice(this.lastApiMessageCount);
    // Estimate only the trailing delta — avoids re-stringifying the entire array
    return this.lastApiTokenCount + Math.ceil(JSON.stringify(trailingMessages).length / 4);
  }

  /**
   * Rough conversation-only token estimate (chars/4 heuristic).
   * Uses cached JSON to avoid repeated stringification.
   */
  estimateTokens(): number {
    return Math.ceil(this.getMessagesJson().length / 4);
  }

  // ── Clear ─────────────────────────────────────────────────────

  clear(): void {
    this.messages = [];
    this.invalidateMessagesCache();
    this.lastApiTokenCount = null;
    this.lastApiMessageCount = 0;
  }
}
