import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import type { Credentials } from "./auth.js";
import {
  aggregate,
  CodexStreamTranslator,
  parseSSE,
  toResponsesRequest,
  upstreamErrorMessage,
  type ChatChunk,
  type ChatRequest,
} from "./translate.js";

/** ash → proxy header carrying the session id (see requestHeaders hook). */
export const SESSION_HEADER = "x-agent-sh-session";

export interface ProxyOptions {
  secret: string;
  upstreamURL: string;
  originator: string;
  getCredentials: () => Promise<Credentials | null>;
  /** Refresh after the upstream rejected `staleAccess`. */
  refreshCredentials: (staleAccess: string) => Promise<Credentials | null>;
  /** Transport limits; progress means upstream bytes, not downstream heartbeats. */
  credentialsTimeoutMs?: number;
  /** Includes request upload and upstream queuing, not just connection setup. */
  headersTimeoutMs?: number;
  idleTimeoutMs?: number;
  heartbeatIntervalMs?: number;
}

export interface Proxy {
  baseURL: string;
  close: () => Promise<void>;
}

export async function startProxy(opts: ProxyOptions): Promise<Proxy> {
  const credentialsTimeoutMs = positiveTimeout(opts.credentialsTimeoutMs, 120_000);
  const headersTimeoutMs = positiveTimeout(opts.headersTimeoutMs, 10 * 60_000);
  const idleTimeoutMs = positiveTimeout(opts.idleTimeoutMs, 30 * 60_000);
  const heartbeatIntervalMs = positiveTimeout(opts.heartbeatIntervalMs, 15_000);
  opts = { ...opts, credentialsTimeoutMs, headersTimeoutMs, idleTimeoutMs, heartbeatIntervalMs };
  const server = http.createServer((req, res) => {
    handle(req, res, opts).catch((err) => sendError(res, 502, errorText(err)));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  server.unref();
  const { port } = server.address() as AddressInfo;
  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    close: () => new Promise<void>((resolve) => {
      server.close(() => resolve());
      // Closing a session must also cancel active upstream requests.
      server.closeAllConnections();
    }),
  };
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse, opts: ProxyOptions): Promise<void> {
  if (req.headers.authorization !== `Bearer ${opts.secret}`) {
    return sendError(res, 401, "Invalid proxy key");
  }
  const { pathname } = new URL(req.url ?? "/", "http://localhost");
  if (req.method !== "POST" || pathname !== "/v1/chat/completions") {
    return sendError(res, 404, `Not found: ${req.method} ${pathname}`);
  }

  const chat = JSON.parse(await readBody(req)) as ChatRequest;
  if (res.destroyed) return;
  const sessionId = headerValue(req, SESSION_HEADER);
  const body = JSON.stringify(toResponsesRequest(chat, { sessionId }));
  const abort = new AbortController();
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let timeoutError: Error | undefined;
  let outputStarted = false;
  const armDeadline = (ms: number, phase: string) => {
    clearTimeout(deadline);
    deadline = setTimeout(() => {
      timeoutError = new Error(`Codex upstream timed out ${phase} after ${ms / 1000}s`);
      abort.abort(timeoutError);
    }, ms);
    deadline.unref();
  };
  const onClose = () => { if (!res.writableFinished) abort.abort(); };
  res.on("close", onClose);

  try {
    armDeadline(opts.credentialsTimeoutMs!, "waiting for credentials");
    let creds: Credentials | null;
    try {
      creds = await waitForCredentials(() => opts.getCredentials(), abort.signal);
    } catch (err) {
      if (abort.signal.aborted) throw abort.signal.reason;
      return sendError(res, 401, `ChatGPT sign-in could not be refreshed (${errorText(err)}). Run /codex-login.`);
    }
    if (!creds) return sendError(res, 401, "Not signed in to ChatGPT. Run /codex-login first.");
    if (abort.signal.aborted) throw abort.signal.reason;

    // Large image requests can take minutes to upload before upstream sends any
    // headers. Acknowledging only after fetch resolves makes the SDK/loopback
    // transport time out and silently re-upload the same request. Begin SSE as
    // soon as local authentication succeeds; comments contain no model output.
    if (chat.stream) {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.flushHeaders();
      heartbeat = setInterval(() => {
        if (!res.destroyed && !res.writableEnded && !res.writableLength) res.write(": keepalive\n\n");
      }, opts.heartbeatIntervalMs!);
      heartbeat.unref();
    }
    armDeadline(opts.headersTimeoutMs!, "waiting for response headers");
    let upstream = await callUpstream(opts, creds, body, sessionId, abort.signal);
    if (upstream.status === 401) {
      await upstream.body?.cancel();
      armDeadline(opts.credentialsTimeoutMs!, "waiting for refreshed credentials");
      try {
        const staleAccess = creds.access;
        creds = await waitForCredentials(() => opts.refreshCredentials(staleAccess), abort.signal);
      } catch (err) {
        if (abort.signal.aborted) throw abort.signal.reason;
        return sendError(res, 401, `ChatGPT sign-in could not be refreshed (${errorText(err)}). Run /codex-login.`);
      }
      if (abort.signal.aborted) throw abort.signal.reason;
      if (!creds) return sendError(res, 401, "ChatGPT session expired. Run /codex-login again.");
      armDeadline(opts.headersTimeoutMs!, "waiting for response headers");
      upstream = await callUpstream(opts, creds, body, sessionId, abort.signal);
    }
    if (!upstream.ok) {
      let errorBody = "";
      try { errorBody = await upstream.text(); }
      catch (err) {
        if (abort.signal.aborted) throw err;
        // A broken error body must not erase a known 4xx/5xx status or its
        // retry policy. No model output has been sent on this path.
      }
      return sendError(res, upstream.status, upstreamErrorMessage(upstream.status, errorBody), upstream.headers.get("retry-after") ?? undefined);
    }
    if (!upstream.body) throw new TransportError(Object.assign(new Error("Codex upstream returned no response body"), {
      code: "ERR_STREAM_PREMATURE_CLOSE",
    }), "body");

    const translator = new CodexStreamTranslator(chat.model);
    const upstreamBody = upstream.body;
    const resetIdle = () => armDeadline(opts.idleTimeoutMs!, "waiting for stream data");
    resetIdle();
    // Count even SSE comments and untranslatable events as upstream activity.
    // Our own keepalives must never extend the upstream inactivity deadline.
    async function* observedBody() {
      try {
        for await (const bytes of upstreamBody as unknown as AsyncIterable<Uint8Array>) {
          if (bytes.length) resetIdle();
          yield bytes;
        }
      } catch (err) {
        throw new TransportError(err, "body");
      }
    }
    async function* checkedEvents() {
      let terminalReceived = false;
      try {
        for await (const event of parseSSE(observedBody())) {
          terminalReceived = ["response.completed", "response.done", "response.incomplete"].includes(event.type);
          yield event;
          // A terminal event finishes the response, even if a gateway keeps the
          // HTTP body open. Returning also cancels the unread upstream stream.
          if (terminalReceived) return;
        }
      } catch (err) {
        // Iterator cleanup can itself fail when the transport is closing.
        // Once completion was received, that failure must not discard the
        // answer or trigger a replay. Errors before completion still propagate.
        if (!terminalReceived) throw err;
      }
      if (!terminalReceived) {
        throw new TransportError(Object.assign(new Error("Codex upstream stream ended before completion"), {
          code: "ERR_STREAM_PREMATURE_CLOSE",
        }), "body");
      }
    }
    const events = checkedEvents();

    if (!chat.stream) {
      const chunks: ChatChunk[] = [];
      for await (const event of events) chunks.push(...translator.push(event));
      chunks.push(...translator.end());
      return sendJson(res, 200, aggregate(chunks));
    }

    const write = (payload: unknown) => {
      outputStarted = true;
      return res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };
    for await (const event of events) for (const chunk of translator.push(event)) write(chunk);
    for (const chunk of translator.end()) write(chunk);
    res.end("data: [DONE]\n\n");
  } catch (err) {
    if (res.destroyed) return;
    const message = errorText(timeoutError ?? err);
    // An early local SSE handshake says nothing about upstream progress. Keep
    // transient transport errors retryable until actual model output is sent.
    // Replaying after text, reasoning or tool deltas would duplicate UI output;
    // provider/application errors and spent local deadlines must not be retried.
    const transport = err instanceof TransportError ? err : undefined;
    sendError(res, timeoutError ? 504 : 502, message, undefined, {
      retryable: !timeoutError && !abort.signal.aborted && !outputStarted && !!transport?.retryable,
      ...(transport && { phase: transport.phase, code: transport.code }),
      partial: outputStarted,
    });
  } finally {
    clearTimeout(deadline);
    clearInterval(heartbeat);
    res.removeListener("close", onClose);
    abort.abort(); // Release any unread upstream body on errors/early returns.
  }
}

// Token refresh can be shared by concurrent requests. Stop this caller's wait
// on timeout/disconnect without cancelling another caller's credential refresh.
async function waitForCredentials<T>(read: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let onAbort!: () => void;
  const interrupted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([read(), interrupted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function positiveTimeout(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0 || value > 2_147_483_647) {
    throw new Error("Codex proxy timeouts must be positive finite milliseconds");
  }
  return value;
}

async function callUpstream(
  opts: ProxyOptions,
  creds: Credentials,
  body: string,
  sessionId: string | undefined,
  signal: AbortSignal,
): Promise<Response> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${creds.access}`,
    "chatgpt-account-id": creds.accountId,
    originator: opts.originator,
    "user-agent": `agent-sh (${os.platform()} ${os.release()}; ${os.arch()})`,
    "openai-beta": "responses=experimental",
    accept: "text/event-stream",
    "content-type": "application/json",
  };
  if (sessionId) headers.session_id = sessionId;
  try {
    return await fetch(opts.upstreamURL, { method: "POST", headers, body, signal });
  } catch (err) {
    throw new TransportError(err, "headers");
  }
}

// Classify failures at the I/O boundary, not arbitrary model error text. Node
// fetch carries socket/TLS codes in cause; Electron exposes Chromium names in
// the message. In particular, a certificate failure is not a transient outage.
const TRANSIENT_CODES = new Set([
  "ECONNRESET", "ECONNREFUSED", "ECONNABORTED", "ETIMEDOUT", "EPIPE", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH",
  "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT",
  "ERR_STREAM_PREMATURE_CLOSE", "ERR_HTTP2_PROTOCOL_ERROR", "ERR_HTTP2_SERVER_REFUSED_STREAM",
  "ERR_HTTP2_PING_FAILED", "ERR_HTTP2_STREAM_CLOSED", "ERR_QUIC_PROTOCOL_ERROR",
  "ERR_CONNECTION_RESET", "ERR_CONNECTION_CLOSED", "ERR_CONNECTION_ABORTED", "ERR_CONNECTION_REFUSED",
  "ERR_TIMED_OUT", "ERR_CONNECTION_TIMED_OUT", "ERR_NETWORK_CHANGED", "ERR_INTERNET_DISCONNECTED",
  "ERR_ADDRESS_UNREACHABLE", "ERR_NAME_NOT_RESOLVED",
]);
class TransportError extends Error {
  readonly code?: string;
  readonly retryable: boolean;
  constructor(cause: unknown, readonly phase: "headers" | "body") {
    super(errorText(cause), { cause });
    let current = cause;
    let aborted = false;
    // Bound traversal even for malformed/circular error causes. Prefer the
    // underlying cause's code to a generic fetch wrapper code.
    for (let depth = 0; depth < 8 && current && typeof current === "object"; depth++) {
      const error = current as { code?: unknown; message?: unknown; name?: unknown; cause?: unknown };
      aborted ||= error.name === "AbortError";
      const code = typeof error.code === "string" ? error.code
        : typeof error.message === "string" ? /^net::(ERR_[A-Z0-9_]+)$/.exec(error.message)?.[1] : undefined;
      if (code) this.code = code;
      current = error.cause;
    }
    this.retryable = !aborted && (this.code ? TRANSIENT_CODES.has(this.code)
      : cause instanceof TypeError && cause.message === "fetch failed");
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function headerValue(req: http.IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v || undefined;
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

function sendError(res: http.ServerResponse, status: number, message: string, retryAfter?: string,
  details: { retryable?: boolean; phase?: string; code?: string; partial?: boolean } = {}): void {
  const retryable = details.retryable ?? ([408, 409, 429].includes(status) || status >= 500);
  const error = { message, type: "codex_proxy_error", status, ...details, retryable,
    ...(retryAfter ? { retry_after: retryAfter } : {}) };
  if (res.headersSent) {
    // The upstream status is unavailable at our earlier SSE handshake. Preserve
    // it in the error envelope so the agent can still distinguish auth/limits.
    // Preserve the SDK's HTTP retry policy after an early SSE handshake. A
    // local deadline is different from an upstream 504: its budget is spent.
    res.end(`data: ${JSON.stringify({ error })}\n\n`);
    return;
  }
  // Preserve explicit no-retry decisions for non-streaming callers as well:
  // local deadlines, permanent failures and partial output cannot be replayed.
  if (!retryable) res.setHeader("x-should-retry", "false");
  sendJson(res, status, { error });
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
