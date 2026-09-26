/** `agent-sh -p` end to end: the built CLI against a local fake
 *  OpenAI-compatible server, no TUI and no API keys. */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../../dist/cli/index.js", import.meta.url));

interface ChatRequest { messages: { role: string; content: unknown }[]; tools?: { function: { name: string } }[] }
type Reply = Record<string, unknown> | { status: number };

async function fakeLlm(reply: (req: ChatRequest) => Reply): Promise<{ url: string; requests: ChatRequest[]; server: Server }> {
  const requests: ChatRequest[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      if (!req.url?.endsWith("/chat/completions")) {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [] }));
        return;
      }
      const parsed = JSON.parse(body) as ChatRequest;
      requests.push(parsed);
      const r = reply(parsed);
      if ("status" in r) {
        res.writeHead(r.status as number, { "content-type": "application/json" })
          .end(JSON.stringify({ error: { message: "fake failure" } }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: r }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, requests, server };
}

function runCli(args: string[], url: string, stdin?: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const home = mkdtempSync(join(tmpdir(), "agent-sh-headless-"));
  return new Promise((resolve) => {
    const child = spawn("node", [CLI, "--api-key", "test", "--base-url", url, "--model", "fake", ...args], {
      cwd: home,
      env: { PATH: process.env.PATH, HOME: home, AGENT_SH_HOME: join(home, ".agent-sh"), AGENT_SH_SKIP_SHELL_ENV: "1" },
      stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    if (stdin !== undefined) child.stdin!.end(stdin);
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (c) => { stdout += c; });
    child.stderr!.on("data", (c) => { stderr += c; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 20000);
    child.on("close", (code) => {
      clearTimeout(timer);
      rmSync(home, { recursive: true, force: true });
      resolve({ code, stdout, stderr });
    });
  });
}

const events = (stdout: string) => stdout.trim().split("\n").map((l) => JSON.parse(l) as Record<string, any>);
const lastUser = (req: ChatRequest) => String([...req.messages].reverse().find((m) => m.role === "user")?.content ?? "");
const toolCall = (name: string, args: unknown) => ({
  tool_calls: [{ index: 0, id: `call_${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } }],
});

test("-p prints the reply to stdout and exits 0", async () => {
  const llm = await fakeLlm(() => ({ content: "hello from fake" }));
  try {
    const r = await runCli(["-p", "say hi"], llm.url);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout.trim(), "hello from fake");
    assert.match(lastUser(llm.requests[0]!), /say hi/);
  } finally { llm.server.close(); }
});

test("piped stdin is appended to the prompt", async () => {
  const llm = await fakeLlm(() => ({ content: "ok" }));
  try {
    const r = await runCli(["-p", "review this"], llm.url, "PIPED DIFF");
    assert.equal(r.code, 0, r.stderr);
    assert.match(lastUser(llm.requests[0]!), /review this\s+PIPED DIFF/);
  } finally { llm.server.close(); }
});

test("--output json reports tool calls and a final done event", async () => {
  const llm = await fakeLlm((req) => req.messages.some((m) => m.role === "tool") ? { content: "listed" } : toolCall("ls", { path: "." }));
  try {
    const r = await runCli(["-p", "list files", "--output", "json"], llm.url);
    assert.equal(r.code, 0, r.stderr);
    const ev = events(r.stdout);
    const start = ev.find((e) => e.type === "tool_start");
    assert.equal(start?.name, "ls");
    assert.equal(ev.find((e) => e.type === "tool_end")?.exitCode, 0);
    assert.deepEqual(ev.at(-1), { type: "done", exitCode: 0, response: "listed" });
  } finally { llm.server.close(); }
});

test("an LLM error exits 1 with an error event", async () => {
  const llm = await fakeLlm(() => ({ status: 400 }));
  try {
    const r = await runCli(["-p", "hi", "--output", "json"], llm.url);
    assert.equal(r.code, 1);
    assert.ok(events(r.stdout).some((e) => e.type === "error"), r.stdout);
  } finally { llm.server.close(); }
});
