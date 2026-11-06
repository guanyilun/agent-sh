/** Subprocess driver for steering ids: edit, targeted cancel, legacy cancel-last. */
import * as http from "node:http";
import { createCore } from "../../src/core/index.js";
import agentBackend from "../../src/agent/index.js";
import type { AppConfig, ExtensionContext } from "../../src/shell/host-types.js";
import type { AgentSurface } from "../../src/agent/host-types.js";

type Msg = { role: string; content?: unknown };

function sse(body: Record<string, unknown>): string {
  return `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 0, model: "stub", ...body })}\n\n`;
}

async function main() {
  const requests: Msg[][] = [];
  let bus: ReturnType<typeof createCore>["bus"];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      try { requests.push((JSON.parse(body).messages ?? []) as Msg[]); } catch { requests.push([]); }
      if (requests.length === 1) {
        bus.emit("agent:steer", { text: "A", id: "a" });
        bus.emit("agent:steer", { text: "B", id: "b" });
        bus.emit("agent:steer", { text: "A-edited", id: "a" });
        bus.emit("agent:steer-cancel", { id: "b" });
        bus.emit("agent:steer", { text: "C" });
        bus.emit("agent:steer-cancel", {});
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      setTimeout(() => {
        res.write(sse({ choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }));
        res.write("data: [DONE]\n\n");
        res.end();
      }, 50);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const baseURL = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;

  const core = createCore({} as AppConfig);
  bus = core.bus;
  const ctx = core.extensionContext({ quit: () => {} });
  agentBackend(ctx);
  const agent = (ctx as ExtensionContext & { agent: AgentSurface }).agent;
  agent.providers.register({ id: "stub", apiKey: "stub", baseURL, models: [{ id: "stub" }] });
  core.bus.emit("core:extensions-loaded", { names: [] });
  await core.activateBackend("ash");
  await new Promise((r) => setImmediate(r));

  const queued: unknown[] = [];
  const dropped: unknown[] = [];
  const consumed: unknown[] = [];
  core.bus.on("agent:steer-queued", ({ text, id, depth }) => { queued.push({ text, id, depth }); });
  core.bus.on("agent:steer-dropped", ({ texts, ids, reason }) => { dropped.push({ texts, ids, reason }); });
  core.bus.on("agent:steer-consumed", ({ text, id }) => { consumed.push({ text, id }); });

  const done = new Promise<void>((r) => core.bus.on("agent:processing-done", () => r()));
  core.bus.emit("agent:submit", { query: "start" });
  await Promise.race([done, new Promise((r) => setTimeout(r, 15000))]);

  const userTexts = (requests[1] ?? []).filter((m) => m.role === "user").map((m) => String(m.content));
  process.stdout.write(JSON.stringify({ queued, dropped, consumed, userTexts, requestCount: requests.length }) + "\n");
  server.close();
  process.exit(0);
}

main().catch((err) => {
  console.error("driver error:", err);
  process.exit(1);
});
