/** LlmClient forwards per-request headers (e.g. OpenRouter x-session-id) to the
 *  SDK request options, not into the request body. */
import test from "node:test";
import assert from "node:assert/strict";
import { LlmClient } from "../../src/agent/llm-client.js";

/** Replace the SDK call with a spy and return what stream() passed it. */
function captureStream(client: LlmClient, opts: Record<string, unknown>): { body: any; reqOpts: any } {
  let captured: { body: any; reqOpts: any } | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (client as any).client.chat.completions = {
    create: (body: any, reqOpts: any) => {
      captured = { body, reqOpts };
      return (async function* () { /* empty stream */ })();
    },
  };
  client.stream(opts as never);
  return captured!;
}

test("stream() forwards headers to the SDK request options, not the body", () => {
  const client = new LlmClient({ apiKey: "x", model: "m" });
  const { body, reqOpts } = captureStream(client, {
    messages: [],
    headers: { "x-session-id": "sess-abc" },
  });

  assert.equal(reqOpts.headers["x-session-id"], "sess-abc", "header reaches the transport layer");
  assert.ok(!("headers" in body), "headers must not leak into the request body");
});

test("stream() omits the headers option when none are supplied", () => {
  const client = new LlmClient({ apiKey: "x", model: "m" });
  const { body, reqOpts } = captureStream(client, { messages: [] });

  assert.equal(reqOpts.headers, undefined, "no headers passed → undefined, SDK uses defaults only");
  assert.ok(!("headers" in body));
});
