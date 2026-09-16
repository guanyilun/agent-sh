/**
 * Chat Completions ⇄ Codex Responses translation (pure, no I/O).
 * Encrypted reasoning round-trips via reasoning_details (needs echoReasoning).
 */

export interface ChatToolCall {
  id: string;
  type?: string;
  function: { name: string; arguments?: string };
}

export interface ChatMessage {
  role: string;
  content?: unknown;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
  reasoning_details?: unknown;
}

export interface ChatTool {
  type: string;
  function?: { name: string; description?: string; parameters?: unknown };
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ChatTool[];
  stream?: boolean;
  reasoning_effort?: string;
}

export interface ChatUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: { cached_tokens: number };
}

export interface ChatChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: Array<{ index: 0; delta: Record<string, unknown>; finish_reason: string | null }>;
  usage?: ChatUsage;
}

type UpstreamEvent = Record<string, any>;

/** Marks reasoning_details entries emitted by this proxy. */
export const REASONING_DETAIL_TYPE = "codex.reasoning";

type InputPart =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url: string; detail: "auto" };

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((p) => p?.type === "text" && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("\n");
}

function inputParts(content: unknown): InputPart[] {
  if (typeof content === "string") return content ? [{ type: "input_text", text: content }] : [];
  if (!Array.isArray(content)) return [];
  const out: InputPart[] = [];
  for (const p of content) {
    if (p?.type === "text" && typeof p.text === "string") {
      out.push({ type: "input_text", text: p.text });
    } else if (p?.type === "image_url") {
      const url = typeof p.image_url === "string" ? p.image_url : p.image_url?.url;
      if (typeof url === "string") out.push({ type: "input_image", image_url: url, detail: "auto" });
    }
  }
  return out;
}

function replayedReasoning(details: unknown): Record<string, unknown>[] {
  if (!Array.isArray(details)) return [];
  return details
    .filter((d) => d?.type === REASONING_DETAIL_TYPE && d.item && typeof d.item === "object")
    .map((d) => d.item as Record<string, unknown>);
}

export function toResponsesRequest(
  req: ChatRequest,
  opts: { sessionId?: string } = {},
): Record<string, unknown> {
  const instructions: string[] = [];
  const input: Record<string, unknown>[] = [];
  let inPreamble = true;

  for (const m of req.messages ?? []) {
    if (m.role === "system" || m.role === "developer") {
      const text = textOf(m.content);
      if (!text) continue;
      if (inPreamble) instructions.push(text);
      else input.push({ type: "message", role: "developer", content: [{ type: "input_text", text }] });
      continue;
    }
    inPreamble = false;

    if (m.role === "user") {
      const content = inputParts(m.content);
      if (content.length) input.push({ type: "message", role: "user", content });
    } else if (m.role === "assistant") {
      // Reasoning items must precede the message/calls they produced.
      input.push(...replayedReasoning(m.reasoning_details));
      const text = textOf(m.content);
      if (text) {
        input.push({
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text, annotations: [] }],
        });
      }
      for (const tc of m.tool_calls ?? []) {
        input.push({
          type: "function_call",
          call_id: tc.id,
          name: tc.function.name,
          arguments: tc.function.arguments || "{}",
        });
      }
    } else if (m.role === "tool") {
      const output = typeof m.content === "string" ? m.content : inputParts(m.content);
      input.push({ type: "function_call_output", call_id: m.tool_call_id, output });
    }
  }

  const tools = (req.tools ?? [])
    .filter((t) => t.type === "function" && t.function?.name)
    .map((t) => ({
      type: "function",
      name: t.function!.name,
      description: t.function!.description ?? "",
      parameters: t.function!.parameters ?? { type: "object", properties: {} },
      strict: false,
    }));

  const body: Record<string, unknown> = {
    model: req.model,
    instructions: instructions.join("\n\n"),
    input,
    store: false,
    stream: true,
    include: ["reasoning.encrypted_content"],
    reasoning: {
      ...(req.reasoning_effort ? { effort: req.reasoning_effort } : {}),
      summary: "auto",
    },
  };
  if (tools.length) {
    body.tools = tools;
    body.tool_choice = "auto";
    body.parallel_tool_calls = true;
  }
  if (opts.sessionId) body.prompt_cache_key = opts.sessionId;
  return body;
}

export class CodexStreamTranslator {
  private readonly id = `chatcmpl-codex-${Date.now().toString(36)}`;
  private readonly created = Math.floor(Date.now() / 1000);
  private sentRole = false;
  /** Upstream item id / output_index → tool_calls index. */
  private readonly toolIndex = new Map<string, number>();
  private readonly toolArgs: string[] = [];
  private reasoningCount = 0;
  private status: string | undefined;
  private usage: ChatUsage | undefined;

  constructor(private readonly model: string) {}

  push(event: UpstreamEvent): ChatChunk[] {
    switch (event.type) {
      case "response.output_text.delta":
      case "response.refusal.delta":
        return event.delta ? [this.chunk({ content: event.delta })] : [];
      case "response.reasoning_summary_text.delta":
        return event.delta ? [this.chunk({ reasoning: event.delta })] : [];
      case "response.reasoning_summary_part.added":
        return (event.summary_index ?? 0) > 0 ? [this.chunk({ reasoning: "\n\n" })] : [];
      case "response.output_item.added":
        return event.item?.type === "function_call" ? [this.startToolCall(event.item, event.output_index)] : [];
      case "response.function_call_arguments.delta":
        return this.appendArgs(this.lookupTool(event), event.delta ?? "");
      case "response.function_call_arguments.done":
        return this.reconcileArgs(this.lookupTool(event), event.arguments);
      case "response.output_item.done":
        return this.itemDone(event.item, event.output_index);
      case "response.completed":
      case "response.done":
      case "response.incomplete":
        this.finish(event.response);
        return [];
      case "response.failed":
        throw new Error(event.response?.error?.message ?? "Codex response failed");
      case "error":
        throw new Error(event.message ?? event.code ?? "Codex stream error");
      default:
        return [];
    }
  }

  /** finish_reason chunk, then usage chunk. */
  end(): ChatChunk[] {
    const finish = this.status === "incomplete" ? "length"
      : this.toolArgs.length > 0 ? "tool_calls"
      : "stop";
    const out: ChatChunk[] = [this.chunk({}, finish)];
    if (this.usage) out.push({ ...this.base(), choices: [], usage: this.usage });
    return out;
  }

  private base(): Omit<ChatChunk, "choices"> {
    return { id: this.id, object: "chat.completion.chunk", created: this.created, model: this.model };
  }

  private chunk(delta: Record<string, unknown>, finish: string | null = null): ChatChunk {
    if (!this.sentRole) {
      delta = { role: "assistant", ...delta };
      this.sentRole = true;
    }
    return { ...this.base(), choices: [{ index: 0, delta, finish_reason: finish }] };
  }

  private startToolCall(item: UpstreamEvent, outputIndex?: number): ChatChunk {
    const idx = this.toolArgs.length;
    const args = typeof item.arguments === "string" ? item.arguments : "";
    this.toolArgs.push(args);
    if (item.id) this.toolIndex.set(`item:${item.id}`, idx);
    if (outputIndex !== undefined) this.toolIndex.set(`out:${outputIndex}`, idx);
    return this.chunk({
      tool_calls: [{ index: idx, id: item.call_id, type: "function", function: { name: item.name, arguments: args } }],
    });
  }

  private lookupTool(event: UpstreamEvent): number | undefined {
    return this.toolIndex.get(`item:${event.item_id}`) ?? this.toolIndex.get(`out:${event.output_index}`);
  }

  private appendArgs(idx: number | undefined, delta: string): ChatChunk[] {
    if (idx === undefined || !delta) return [];
    this.toolArgs[idx] += delta;
    return [this.chunk({ tool_calls: [{ index: idx, function: { arguments: delta } }] })];
  }

  /** The final argument string can carry a tail the deltas never sent. */
  private reconcileArgs(idx: number | undefined, full: unknown): ChatChunk[] {
    if (idx === undefined || typeof full !== "string") return [];
    const seen = this.toolArgs[idx]!;
    if (full.length <= seen.length || !full.startsWith(seen)) return [];
    return this.appendArgs(idx, full.slice(seen.length));
  }

  private itemDone(item: UpstreamEvent | undefined, outputIndex?: number): ChatChunk[] {
    if (item?.type === "reasoning" && item.encrypted_content) {
      return [this.chunk({
        reasoning_details: [{ index: this.reasoningCount++, type: REASONING_DETAIL_TYPE, item }],
      })];
    }
    if (item?.type === "function_call") {
      const idx = this.toolIndex.get(`item:${item.id}`) ?? this.toolIndex.get(`out:${outputIndex}`);
      if (idx === undefined) return [this.startToolCall(item, outputIndex)];
      return this.reconcileArgs(idx, item.arguments);
    }
    return [];
  }

  private finish(response: UpstreamEvent | undefined): void {
    this.status = response?.status;
    const u = response?.usage;
    if (!u) return;
    const input = u.input_tokens ?? 0;
    const output = u.output_tokens ?? 0;
    this.usage = {
      prompt_tokens: input,
      completion_tokens: output,
      total_tokens: u.total_tokens ?? input + output,
      prompt_tokens_details: { cached_tokens: u.input_tokens_details?.cached_tokens ?? 0 },
    };
  }
}

/** Fold translated chunks into a non-streaming chat.completion body. */
export function aggregate(chunks: ChatChunk[]): Record<string, unknown> {
  let content = "";
  let finish: string | null = null;
  let usage: ChatUsage | undefined;
  const calls: { id: string; type: "function"; function: { name: string; arguments: string } }[] = [];
  const head = chunks[0];

  for (const c of chunks) {
    if (c.usage) usage = c.usage;
    const choice = c.choices[0];
    if (!choice) continue;
    if (choice.finish_reason) finish = choice.finish_reason;
    const delta = choice.delta as {
      content?: string;
      tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[];
    };
    if (delta.content) content += delta.content;
    for (const tc of delta.tool_calls ?? []) {
      const slot = (calls[tc.index] ??= { id: "", type: "function", function: { name: "", arguments: "" } });
      if (tc.id) slot.id = tc.id;
      if (tc.function?.name) slot.function.name = tc.function.name;
      if (tc.function?.arguments) slot.function.arguments += tc.function.arguments;
    }
  }

  return {
    id: head?.id ?? "chatcmpl-codex",
    object: "chat.completion",
    created: head?.created ?? Math.floor(Date.now() / 1000),
    model: head?.model ?? "",
    choices: [{
      index: 0,
      message: { role: "assistant", content: content || null, ...(calls.length ? { tool_calls: calls } : {}) },
      finish_reason: finish ?? "stop",
    }],
    ...(usage ? { usage } : {}),
  };
}

export async function* parseSSE(body: AsyncIterable<Uint8Array>): AsyncGenerator<UpstreamEvent> {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const bytes of body) {
    buf = (buf + decoder.decode(bytes, { stream: true })).replace(/\r\n/g, "\n");
    let i: number;
    while ((i = buf.indexOf("\n\n")) !== -1) {
      const event = parseBlock(buf.slice(0, i));
      buf = buf.slice(i + 2);
      if (event) yield event;
    }
  }
  const tail = parseBlock(buf + decoder.decode());
  if (tail) yield tail;
}

function parseBlock(block: string): UpstreamEvent | null {
  const data = block
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).replace(/^ /, ""))
    .join("\n")
    .trim();
  if (!data || data === "[DONE]") return null;
  try {
    return JSON.parse(data) as UpstreamEvent;
  } catch {
    return null;
  }
}

export function upstreamErrorMessage(status: number, text: string): string {
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { /* plain-text body */ }
  const err = parsed?.error;
  const code = String(err?.code ?? err?.type ?? "");
  if (status === 429 || /usage_limit_reached|usage_not_included|rate_limit_exceeded/i.test(code)) {
    const plan = err?.plan_type ? ` (${String(err.plan_type).toLowerCase()} plan)` : "";
    const mins = typeof err?.resets_at === "number"
      ? Math.max(0, Math.round((err.resets_at * 1000 - Date.now()) / 60000))
      : undefined;
    return `ChatGPT usage limit reached${plan}.${mins !== undefined ? ` Resets in ~${mins} min.` : ""}`;
  }
  const detail = err?.message
    ?? (typeof parsed?.detail === "string" ? parsed.detail : undefined)
    ?? text.trim().slice(0, 500);
  return `Codex backend error ${status}${detail ? `: ${detail}` : ""}`;
}
