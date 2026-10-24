/**
 * Thin, stateless wrapper around the OpenAI SDK.
 * No agent-sh knowledge — just a configured client.
 *
 * Used by both AgentLoop (full tool loop) and fast-path features
 * (command suggestions, completions).
 */
import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
  ChatCompletionCreateParamsStreaming,
  ChatCompletionCreateParamsNonStreaming,
} from "openai/resources/chat/completions.js";

export type { ChatCompletionMessageParam, ChatCompletionTool };

/** Codex may acknowledge SSE before the upstream HTTP status is available.
 * The SDK preserves the later error envelope but leaves APIError.status empty.
 */
export function llmErrorStatus(error: unknown): number | undefined {
  if (!(error instanceof Error)) return undefined;
  const e = error as Error & { status?: number; type?: string; error?: { status?: unknown } };
  if (typeof e.status === "number") return e.status;
  const status = e.error?.status;
  return e.type === "codex_proxy_error" && typeof status === "number"
    && Number.isInteger(status) && status >= 400 && status <= 599 ? status : undefined;
}

export type AgentShMessage = ChatCompletionMessageParam & {
  meta?: Record<string, unknown>;
};

export function stripMeta(m: ChatCompletionMessageParam): ChatCompletionMessageParam {
  if (!("meta" in m)) return m;
  const { meta: _meta, ...rest } = m as ChatCompletionMessageParam & { meta?: unknown };
  return rest as ChatCompletionMessageParam;
}

export interface LlmClientConfig {
  apiKey: string;
  baseURL?: string;
  model: string;
  /** Sent as OpenRouter X-Title; ignored by other providers. */
  appName?: string;
  /** Sent as OpenRouter HTTP-Referer; ignored by other providers. */
  appUrl?: string;
}

function attributionHeaders(config: LlmClientConfig): Record<string, string> {
  return {
    "HTTP-Referer": config.appUrl ?? "https://agent-sh.dev",
    "X-Title": config.appName ?? "agent-sh",
    "X-OpenRouter-Categories": "cli-agent,programming-app",
  };
}

export class LlmClient {
  private client: OpenAI;
  public model: string;

  constructor(private config: LlmClientConfig) {
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      defaultHeaders: attributionHeaders(config),
    });
    this.model = config.model;
  }

  /** Swap the underlying client config at runtime (e.g. provider switch). */
  reconfigure(newConfig: LlmClientConfig): void {
    this.config = newConfig;
    this.client = new OpenAI({
      apiKey: newConfig.apiKey,
      baseURL: newConfig.baseURL,
      defaultHeaders: attributionHeaders(newConfig),
    });
    this.model = newConfig.model;
  }

  stream(opts: StreamOpts) {
    const { signal, headers, messages, tools, model, max_tokens, ...rest } = opts;
    const body = {
      ...rest,
      model: model ?? this.model,
      messages: messages.map(stripMeta),
      tools: tools?.length ? tools : undefined,
      max_tokens: max_tokens ?? 65536,
      stream: true as const,
      stream_options: { include_usage: true },
    };
    return this.client.chat.completions.create(body as ChatCompletionCreateParamsStreaming, { signal, headers });
  }

  async complete(opts: CompleteOpts): Promise<string> {
    const { messages, model, max_tokens, ...rest } = opts;
    const body = {
      ...rest,
      model: model ?? this.model,
      messages: messages.map(stripMeta),
      max_tokens: max_tokens ?? 1024,
    };
    const response = await this.client.chat.completions.create(body as ChatCompletionCreateParamsNonStreaming);
    return response.choices[0]?.message?.content ?? "";
  }
}

/** Known fields are typed; extras are forwarded verbatim to the SDK so
 *  provider hooks can ship non-standard params (thinking, reasoning, …). */
export type StreamOpts = {
  messages: ChatCompletionMessageParam[];
  tools?: ChatCompletionTool[];
  model?: string;
  max_tokens?: number;
  signal?: AbortSignal;
  /** Per-request transport headers, forwarded to the SDK (not request body). */
  headers?: Record<string, string>;
} & Record<string, unknown>;

export type CompleteOpts = {
  messages: ChatCompletionMessageParam[];
  model?: string;
  max_tokens?: number;
} & Record<string, unknown>;
