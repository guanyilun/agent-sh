/** Loopback Chat Completions → Codex Responses proxy; 127.0.0.1 only, per-process secret. */
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
  /** Full Codex responses URL, e.g. https://chatgpt.com/backend-api/codex/responses */
  upstreamURL: string;
  originator: string;
  getCredentials: () => Promise<Credentials | null>;
  /** Refresh after the upstream rejected `staleAccess`. */
  refreshCredentials: (staleAccess: string) => Promise<Credentials | null>;
}

export interface Proxy {
  baseURL: string;
  close: () => Promise<void>;
}

export async function startProxy(opts: ProxyOptions): Promise<Proxy> {
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
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
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
  let creds: Credentials | null;
  try {
    creds = await opts.getCredentials();
  } catch (err) {
    return sendError(res, 401, `ChatGPT sign-in could not be refreshed (${errorText(err)}). Run /codex-login.`);
  }
  if (!creds) return sendError(res, 401, "Not signed in to ChatGPT. Run /codex-login first.");

  const sessionId = headerValue(req, SESSION_HEADER);
  const body = JSON.stringify(toResponsesRequest(chat, { sessionId }));
  const abort = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) abort.abort();
  });

  let upstream = await callUpstream(opts, creds, body, sessionId, abort.signal);
  if (upstream.status === 401) {
    try {
      creds = await opts.refreshCredentials(creds.access);
    } catch (err) {
      return sendError(res, 401, `ChatGPT sign-in could not be refreshed (${errorText(err)}). Run /codex-login.`);
    }
    if (!creds) return sendError(res, 401, "ChatGPT session expired. Run /codex-login again.");
    upstream = await callUpstream(opts, creds, body, sessionId, abort.signal);
  }
  if (!upstream.ok || !upstream.body) {
    return sendError(res, upstream.status || 502, upstreamErrorMessage(upstream.status, await upstream.text()));
  }

  const translator = new CodexStreamTranslator(chat.model);
  const events = parseSSE(upstream.body as unknown as AsyncIterable<Uint8Array>);

  if (!chat.stream) {
    const chunks: ChatChunk[] = [];
    for await (const event of events) chunks.push(...translator.push(event));
    chunks.push(...translator.end());
    return sendJson(res, 200, aggregate(chunks));
  }

  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const write = (payload: unknown) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
  try {
    for await (const event of events) for (const chunk of translator.push(event)) write(chunk);
    for (const chunk of translator.end()) write(chunk);
    res.write("data: [DONE]\n\n");
  } catch (err) {
    // headers already sent; the SDK raises on an error payload
    if (!abort.signal.aborted) write({ error: { message: errorText(err), type: "codex_error" } });
  }
  res.end();
}

function callUpstream(
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
  return fetch(opts.upstreamURL, { method: "POST", headers, body, signal });
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

function sendError(res: http.ServerResponse, status: number, message: string): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  sendJson(res, status, { error: { message, type: "codex_proxy_error" } });
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
