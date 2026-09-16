/** OpenAI SDK → proxy → fake Codex backend. */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import OpenAI from "openai";
import type { Credentials } from "../auth.js";
import { SESSION_HEADER, startProxy, type Proxy } from "../proxy.js";

function jwt(accountId: string, tag: string): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64({ "https://api.openai.com/auth": { chatgpt_account_id: accountId }, tag })}.sig`;
}

const oldCreds: Credentials = { access: jwt("acct-123", "old"), refresh: "r1", expires: Date.now() + 3600_000, accountId: "acct-123" };
const newCreds: Credentials = { ...oldCreds, access: jwt("acct-123", "new"), refresh: "r2" };

const SSE_EVENTS = [
  { type: "response.created", response: { id: "resp_1" } },
  { type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs_1" } },
  { type: "response.reasoning_summary_part.added", summary_index: 0 },
  { type: "response.reasoning_summary_text.delta", delta: "thinking" },
  { type: "response.output_item.done", output_index: 0, item: { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "enc" } },
  { type: "response.output_item.added", output_index: 1, item: { type: "message", id: "msg_1" } },
  { type: "response.output_text.delta", delta: "Hel" },
  { type: "response.output_text.delta", delta: "lo" },
  { type: "response.output_item.added", output_index: 2, item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "bash", arguments: "" } },
  { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '{"cmd":"ls"}' },
  { type: "response.output_item.done", output_index: 2, item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "bash", arguments: '{"cmd":"ls"}' } },
  { type: "response.completed", response: { status: "completed", usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, input_tokens_details: { cached_tokens: 4 } } } },
];

type Seen = { headers: http.IncomingHttpHeaders; body: any };
let mode: "ok" | "expire-old" | "limit" = "ok";
const seen: Seen[] = [];
let refreshCalls: string[] = [];
let signedIn = true;
let upstream: http.Server;
let proxy: Proxy;

before(async () => {
  upstream = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      seen.push({ headers: req.headers, body: JSON.parse(raw) });
      if (mode === "limit") {
        res.writeHead(429, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { type: "usage_limit_reached", plan_type: "plus" } }));
        return;
      }
      if (mode === "expire-old" && req.headers.authorization === `Bearer ${oldCreds.access}`) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ detail: "token expired" }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const e of SSE_EVENTS) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
      res.end();
    });
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
  const { port } = upstream.address() as AddressInfo;
  proxy = await startProxy({
    secret: "s3cret",
    upstreamURL: `http://127.0.0.1:${port}/backend-api/codex/responses`,
    originator: "agent-sh",
    getCredentials: async () => (signedIn ? oldCreds : null),
    refreshCredentials: async (stale) => {
      refreshCalls.push(stale);
      return newCreds;
    },
  });
});

after(async () => {
  await proxy.close();
  await new Promise<void>((r) => upstream.close(() => r()));
});

const client = (apiKey = "s3cret") => new OpenAI({ apiKey, baseURL: proxy.baseURL, maxRetries: 0 });
const REQUEST = {
  model: "gpt-5.5",
  messages: [{ role: "system" as const, content: "sys" }, { role: "user" as const, content: "hi" }],
  tools: [{ type: "function" as const, function: { name: "bash", parameters: { type: "object", properties: {} } } }],
};

function reset(nextMode: typeof mode = "ok") {
  mode = nextMode;
  seen.length = 0;
  refreshCalls = [];
  signedIn = true;
}

test("streaming: SDK sees content, reasoning, tool calls, reasoning_details, usage", async () => {
  reset();
  const stream = await client().chat.completions.create(
    { ...REQUEST, stream: true, stream_options: { include_usage: true }, reasoning_effort: "high" } as any,
    { headers: { [SESSION_HEADER]: "sess-1" } },
  ) as unknown as AsyncIterable<any>;

  let content = "", reasoning = "", args = "";
  let toolHead: any, finish: string | null = null, usage: any, details: any[] = [];
  for await (const chunk of stream) {
    if (chunk.usage) usage = chunk.usage;
    const choice = chunk.choices[0];
    if (!choice) continue;
    const d = choice.delta;
    content += d.content ?? "";
    reasoning += d.reasoning ?? "";
    if (d.reasoning_details) details.push(...d.reasoning_details);
    for (const tc of d.tool_calls ?? []) {
      toolHead ??= tc;
      args += tc.function?.arguments ?? "";
    }
    finish = choice.finish_reason ?? finish;
  }
  assert.equal(content, "Hello");
  assert.equal(reasoning, "thinking");
  assert.equal(toolHead.id, "call_1");
  assert.equal(toolHead.function.name, "bash");
  assert.equal(args, '{"cmd":"ls"}');
  assert.equal(details[0].item.encrypted_content, "enc");
  assert.equal(finish, "tool_calls");
  assert.equal(usage.prompt_tokens, 10);
  assert.equal(usage.prompt_tokens_details.cached_tokens, 4);

  const [{ headers, body }] = seen;
  assert.equal(headers.authorization, `Bearer ${oldCreds.access}`);
  assert.equal(headers["chatgpt-account-id"], "acct-123");
  assert.equal(headers.originator, "agent-sh");
  assert.equal(headers.session_id, "sess-1");
  assert.equal(headers["openai-beta"], "responses=experimental");
  assert.equal(body.instructions, "sys");
  assert.deepEqual(body.reasoning, { effort: "high", summary: "auto" });
  assert.equal(body.prompt_cache_key, "sess-1");
  assert.equal(body.store, false);
  assert.equal(body.max_tokens, undefined);
});

test("non-streaming (llm.ask path): aggregated chat.completion", async () => {
  reset();
  const res = await client().chat.completions.create({ ...REQUEST, max_tokens: 100 });
  assert.equal(res.choices[0]!.message.content, "Hello");
  assert.equal(res.choices[0]!.message.tool_calls?.[0]?.id, "call_1");
  assert.equal(res.usage?.total_tokens, 15);
});

test("401 upstream: refreshes once with the stale token, then retries", async () => {
  reset("expire-old");
  const res = await client().chat.completions.create(REQUEST);
  assert.equal(res.choices[0]!.message.content, "Hello");
  assert.deepEqual(refreshCalls, [oldCreds.access]);
  assert.deepEqual(seen.map((s) => s.headers.authorization), [`Bearer ${oldCreds.access}`, `Bearer ${newCreds.access}`]);
});

test("rejects callers without the proxy secret; never reaches upstream", async () => {
  reset();
  await assert.rejects(client("wrong").chat.completions.create(REQUEST), (err: any) => err.status === 401 && /Invalid proxy key/.test(err.message));
  assert.equal(seen.length, 0);
});

test("not signed in → 401 telling the user to /codex-login", async () => {
  reset();
  signedIn = false;
  await assert.rejects(client().chat.completions.create(REQUEST), (err: any) => err.status === 401 && /codex-login/.test(err.message));
  assert.equal(seen.length, 0);
});

test("usage limit → 429 with a friendly message", async () => {
  reset("limit");
  await assert.rejects(client().chat.completions.create(REQUEST), (err: any) => err.status === 429 && /usage limit reached \(plus plan\)/.test(err.message));
});
