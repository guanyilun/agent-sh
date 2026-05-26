import type { ChatCompletionMessageParam, AgentShMessage } from "./llm-client.js";
import { stripMeta } from "./llm-client.js";
import type { HandlerFunctions } from "../utils/handler-registry.js";
import type { ImageContent } from "./types.js";

export interface CompactResult {
  before: number;
  after: number;
  evictedCount: number;
  [extra: string]: unknown;
}

export class LiveView {
  private messages: ChatCompletionMessageParam[] = [];
  private messagesDirty = true;
  private cachedMessagesJson: string | null = null;

  readonly instanceId: string;
  private readonly handlers: HandlerFunctions | null;

  private lastApiTokenCount: number | null = null;
  private lastApiMessageCount: number = 0;

  // Mid-tool-pair user/system messages are buffered and flushed after
  // the trailing tool_result — splicing into the gap breaks
  // reasoning_content pairing on strict providers.
  private pendingMessages: Array<{ kind: "system" | "user"; text: string }> = [];

  constructor(handlers?: HandlerFunctions, instanceId: string = "0000") {
    this.handlers = handlers ?? null;
    this.instanceId = instanceId;
  }

  private getMessagesJson(): string {
    if (this.messagesDirty || this.cachedMessagesJson === null) {
      this.cachedMessagesJson = JSON.stringify(this.messages);
      this.messagesDirty = false;
    }
    return this.cachedMessagesJson;
  }

  private invalidateMessagesCache(): void {
    this.messagesDirty = true;
    this.cachedMessagesJson = null;
  }

  // ── Message API ──────────────────────────────────────────────

  addUserMessage(text: string): void {
    this.messages.push({ role: "user", content: text });
    this.invalidateMessagesCache();
  }

  addAssistantMessage(
    content: string | null,
    toolCalls?: { id: string; function: { name: string; arguments: string } }[],
    extras?: Record<string, unknown>,
  ): void {
    const hasToolCalls = !!toolCalls?.length;

    // Promote reasoning into content on reasoning-only turns; strict
    // providers (DeepSeek native) reject content="" with no tool_calls.
    if (!content && !hasToolCalls) {
      const r = (extras?.reasoning_content ?? extras?.reasoning) as unknown;
      if (typeof r === "string" && r) content = r;
    }
    if (!content && !hasToolCalls) return;

    const base: Record<string, unknown> = {
      role: "assistant",
      content: hasToolCalls ? (content ?? null) : content,
    };
    if (hasToolCalls) {
      base.tool_calls = toolCalls!.map((tc) => ({
        id: tc.id,
        type: "function" as const,
        function: tc.function,
      }));
    }
    if (extras) Object.assign(base, extras);
    this.messages.push(base as unknown as ChatCompletionMessageParam);
    this.invalidateMessagesCache();
  }

  addToolResult(toolCallId: string, content: string | ImageContent[], isError = false): void {
    if (typeof content === "string") {
      this.messages.push({ role: "tool", tool_call_id: toolCallId, content });
    } else {
      const parts: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> = [];
      for (const img of content) {
        parts.push({ type: "image_url", image_url: { url: `data:${img.mimeType};base64,${img.data}` } });
      }
      const label = isError ? `Error: [${content.length} image(s)]` : `[${content.length} image(s)]`;
      parts.unshift({ type: "text", text: label });
      this.messages.push({ role: "tool", tool_call_id: toolCallId, content: parts } as unknown as ChatCompletionMessageParam);
    }
    this.invalidateMessagesCache();
    this.flushPendingMessages();
  }

  /** Add tool results as a user message (for inline tool protocol). */
  addToolResultInline(content: string): void {
    this.messages.push({ role: "user", content });
    this.invalidateMessagesCache();
    this.flushPendingMessages();
  }

  /** Safe from any context: queues if mid-tool-pair, appends otherwise. */
  addSystemNote(text: string): void {
    if (this.hasOpenToolCalls()) {
      this.pendingMessages.push({ kind: "system", text });
      return;
    }
    this.messages.push({ role: "user", content: text });
    this.invalidateMessagesCache();
  }

  appendUserMessage(text: string): void {
    if (this.hasOpenToolCalls()) {
      this.pendingMessages.push({ kind: "user", text });
      return;
    }
    this.addUserMessage(text);
  }

  private hasOpenToolCalls(): boolean {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const msg = this.messages[i]!;
      if (msg.role === "tool") continue;
      if (msg.role !== "assistant") return false;
      if (!("tool_calls" in msg) || !msg.tool_calls) return false;
      const answered = new Set<string>();
      for (let j = i + 1; j < this.messages.length; j++) {
        const m = this.messages[j]!;
        if (m.role !== "tool") break;
        answered.add((m as { tool_call_id: string }).tool_call_id);
      }
      return msg.tool_calls.some((tc) => !answered.has(tc.id));
    }
    return false;
  }

  private flushPendingMessages(): void {
    if (this.pendingMessages.length === 0) return;
    if (this.hasOpenToolCalls()) return;
    const pending = this.pendingMessages;
    this.pendingMessages = [];
    for (const m of pending) {
      if (m.kind === "user") {
        this.addUserMessage(m.text);
      } else {
        this.messages.push({ role: "user", content: m.text });
      }
    }
    this.invalidateMessagesCache();
  }

  getMessages(): ChatCompletionMessageParam[] {
    return this.normalizeReasoningConsistency(
      this.stubDanglingToolCalls(this.dropOrphanToolMessages(this.messages)),
    );
  }

  get(): AgentShMessage[] {
    return this.messages as AgentShMessage[];
  }

  forLLM(): ChatCompletionMessageParam[] {
    return this.getMessages().map(stripMeta);
  }

  replace(msgs: AgentShMessage[]): void {
    this.replaceMessages(msgs as ChatCompletionMessageParam[]);
  }

  link(index: number, entryId: string): void {
    const m = this.messages[index];
    if (!m) throw new Error(`LiveView.link: no message at index ${index}`);
    const am = m as AgentShMessage;
    am.meta = { ...am.meta, entryId };
  }

  /** DeepSeek 400s on tool messages without a matching tool_call;
   *  compaction can leave such orphans. */
  private dropOrphanToolMessages(
    messages: ChatCompletionMessageParam[],
  ): ChatCompletionMessageParam[] {
    const knownIds = new Set<string>();
    const result: ChatCompletionMessageParam[] = [];
    for (const msg of messages) {
      if (msg.role === "assistant" && "tool_calls" in msg && msg.tool_calls) {
        for (const tc of msg.tool_calls) knownIds.add(tc.id);
      }
      if (msg.role === "tool" && !knownIds.has((msg as { tool_call_id: string }).tool_call_id)) {
        continue;
      }
      result.push(msg);
    }
    return result;
  }

  /** Stub missing tool results after a mid-execution interrupt so
   *  DeepSeek doesn't 400 on dangling tool_calls. */
  private stubDanglingToolCalls(
    messages: ChatCompletionMessageParam[],
  ): ChatCompletionMessageParam[] {
    const result: ChatCompletionMessageParam[] = [];
    let i = 0;
    while (i < messages.length) {
      const msg = messages[i]!;
      result.push(msg);
      i++;
      if (msg.role !== "assistant" || !("tool_calls" in msg) || !msg.tool_calls) continue;
      const seen = new Set<string>();
      while (i < messages.length && messages[i]!.role === "tool") {
        const t = messages[i]! as ChatCompletionMessageParam & { role: "tool"; tool_call_id: string };
        seen.add(t.tool_call_id);
        result.push(t);
        i++;
      }
      for (const tc of msg.tool_calls) {
        if (!seen.has(tc.id)) {
          result.push({ role: "tool", tool_call_id: tc.id, content: "[cancelled]" });
        }
      }
    }
    return result;
  }

  /** DeepSeek 400s if any assistant in a thinking-mode conversation
   *  is missing `reasoning_content`. Cross-alias `reasoning` (from
   *  OpenRouter) and stub gaps with "". */
  private normalizeReasoningConsistency(
    messages: ChatCompletionMessageParam[],
  ): ChatCompletionMessageParam[] {
    const needsNormalize = messages.some(
      (m) => m.role === "assistant" && (
        (m as any).reasoning !== undefined ||
        (m as any).reasoning_content !== undefined ||
        (m as any).reasoning_details !== undefined
      ),
    );
    if (!needsNormalize) return messages;
    return messages.map((m) => {
      if (m.role !== "assistant") return m;
      const a = m as any;
      if (a.reasoning_content !== undefined) return m;
      return { ...m, reasoning_content: a.reasoning ?? "" } as ChatCompletionMessageParam;
    });
  }

  /** Wholesale replace. Invalidates the API token baseline since the
   *  new array's count is unknown. */
  replaceMessages(messages: ChatCompletionMessageParam[]): void {
    this.messages = messages;
    this.invalidateMessagesCache();
    this.lastApiTokenCount = null;
    this.lastApiMessageCount = 0;
    this.flushPendingMessages();
  }


  updateApiTokenCount(promptTokens: number): void {
    this.lastApiTokenCount = promptTokens;
    this.lastApiMessageCount = this.messages.length;
  }

  estimatePromptTokens(): number {
    if (this.lastApiTokenCount === null) return this.estimateTokens();
    const trailing = this.messages.length - this.lastApiMessageCount;
    if (trailing <= 0) return this.lastApiTokenCount;
    const trailingMessages = this.messages.slice(this.lastApiMessageCount);
    return this.lastApiTokenCount + Math.ceil(JSON.stringify(trailingMessages).length / 4);
  }

  estimateTokens(): number {
    return Math.ceil(this.getMessagesJson().length / 4);
  }
}
