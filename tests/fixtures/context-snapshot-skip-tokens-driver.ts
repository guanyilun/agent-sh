/** Subprocess driver for the context:snapshot skipTokens pipeline test.
 *  Runs one turn first so the conversation is non-empty — with an empty
 *  conversation both snapshots would legitimately report 0 tokens and the
 *  test could not tell the flag apart from the default path. */
import * as http from "node:http";
import { createCore } from "../../src/core/index.js";
import agentBackend from "../../src/agent/index.js";
import type { AppConfig, ExtensionContext } from "../../src/shell/host-types.js";
import type { AgentSurface } from "../../src/agent/host-types.js";

function startStubLlm(): Promise<{ baseURL: string; close: () => void }> {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (req.url?.includes("/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "stub" }] }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({
        id: "a", object: "chat.completion.chunk", created: 0, model: "stub",
        choices: [{ index: 0, delta: { role: "assistant", content: "done." }, finish_reason: "stop" }],
      })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({ baseURL: `http://127.0.0.1:${port}/v1`, close: () => server.close() });
    });
  });
}

async function main() {
  const llm = await startStubLlm();
  const core = createCore({} as AppConfig);
  const ctx = core.extensionContext({ quit: () => {} });
  agentBackend(ctx);
  const agent = (ctx as ExtensionContext & { agent: AgentSurface }).agent;

  agent.providers.register({
    id: "stub",
    apiKey: "stub",
    baseURL: llm.baseURL,
    models: [{ id: "stub" }],
  });
  core.bus.emit("core:extensions-loaded", { names: [] });
  await core.activateBackend("ash");
  await new Promise((r) => setImmediate(r));

  const done = new Promise<void>((resolve) => {
    core.bus.on("agent:processing-done", () => resolve());
  });
  core.bus.emit("agent:submit", { query: "hello" });
  // Bounded wait: print something either way so a stall fails the assertion
  // instead of hanging the driver until the test harness kills it.
  await Promise.race([done, new Promise((r) => setTimeout(r, 8000))]);

  const base = { messages: [] as unknown[], contextWindow: 0, activeTokens: 0 };
  const plain = core.bus.emitPipe("context:snapshot", { ...base });
  const skipped = core.bus.emitPipe("context:snapshot", { ...base, skipTokens: true });

  process.stdout.write(JSON.stringify({
    messages: plain.messages.length,
    plain: plain.activeTokens,
    skipped: skipped.activeTokens,
  }) + "\n");
  llm.close();
  process.exit(0);
}

main().catch((err) => {
  console.error("driver error:", err);
  process.exit(1);
});
