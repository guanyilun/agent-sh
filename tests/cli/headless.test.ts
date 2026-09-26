/** `agent-sh -p` end to end against a local fake OpenAI-compatible server. */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../../dist/cli/index.js", import.meta.url));
const SUBAGENTS = fileURLToPath(new URL("../../examples/extensions/subagents", import.meta.url));

interface ChatRequest { messages: { role: string; content: unknown }[]; tools?: { function: { name: string } }[] }
type Reply = Record<string, unknown> | { status: number } | { hang: true };

async function fakeLlm(reply: (req: ChatRequest) => Reply): Promise<{ url: string; requests: ChatRequest[]; requested: Promise<void>; server: Server }> {
  const requests: ChatRequest[] = [];
  let onRequest!: () => void;
  const requested = new Promise<void>((r) => { onRequest = r; });
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
      onRequest();
      const r = reply(parsed);
      if ("hang" in r) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.flushHeaders();
        return;
      }
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
  const close = server.close.bind(server);
  server.close = ((cb?: (err?: Error) => void) => { server.closeAllConnections(); return close(cb); }) as Server["close"];
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, requests, requested, server };
}

interface RunOpts { stdin?: string; env?: Record<string, string>; onSpawn?: (child: ChildProcess) => void }

function runCli(args: string[], url: string, opts: RunOpts = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const home = mkdtempSync(join(tmpdir(), "agent-sh-headless-"));
  return new Promise((resolve) => {
    const child = spawn("node", [CLI, "--api-key", "test", "--base-url", url, "--model", "fake", ...args], {
      cwd: home,
      env: { PATH: process.env.PATH, HOME: home, AGENT_SH_HOME: join(home, ".agent-sh"), AGENT_SH_SKIP_SHELL_ENV: "1", ...opts.env },
      stdio: [opts.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    if (opts.stdin !== undefined) child.stdin!.end(opts.stdin);
    opts.onSpawn?.(child);
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
    const r = await runCli(["-p", "review this"], llm.url, { stdin: "PIPED DIFF" });
    assert.equal(r.code, 0, r.stderr);
    assert.match(lastUser(llm.requests[0]!), /review this\s+PIPED DIFF/);
  } finally { llm.server.close(); }
});

test("--output json reports tool calls and a final done event", async () => {
  const llm = await fakeLlm((req) => req.messages.some((m) => m.role === "tool") ? { content: "listed" } : toolCall("bash", { command: "echo streamed" }));
  try {
    const r = await runCli(["-p", "list files", "--output", "json"], llm.url);
    assert.equal(r.code, 0, r.stderr);
    const ev = events(r.stdout);
    const start = ev.find((e) => e.type === "tool_start");
    assert.equal(start?.name, "bash");
    assert.match(ev.filter((e) => e.type === "tool_output" && e.id === start?.id).map((e) => e.chunk).join(""), /streamed/);
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

test("a bare -p takes the whole prompt from stdin", async () => {
  const llm = await fakeLlm(() => ({ content: "ok" }));
  try {
    const r = await runCli(["-p"], llm.url, { stdin: "ONLY FROM STDIN" });
    assert.equal(r.code, 0, r.stderr);
    assert.match(lastUser(llm.requests[0]!), /ONLY FROM STDIN/);
  } finally { llm.server.close(); }
});

test("-p with no prompt and nothing piped exits 1 without calling the LLM", async () => {
  const llm = await fakeLlm(() => ({ content: "ok" }));
  try {
    const r = await runCli(["-p"], llm.url);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /-p needs a prompt/);
    assert.equal(llm.requests.length, 0);
  } finally { llm.server.close(); }
});

test("text mode keeps tool lines on stderr and only the reply on stdout", async () => {
  const llm = await fakeLlm((req) => req.messages.some((m) => m.role === "tool") ? { content: "the files" } : toolCall("ls", { path: "." }));
  try {
    const r = await runCli(["-p", "list files"], llm.url);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout.trim(), "the files");
    assert.match(r.stderr, /→ ls/);
  } finally { llm.server.close(); }
});

test("an unknown --output format exits 1", async () => {
  const llm = await fakeLlm(() => ({ content: "ok" }));
  try {
    const r = await runCli(["-p", "hi", "--output", "yaml"], llm.url);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /--output must be "text" or "json"/);
  } finally { llm.server.close(); }
});

test("-p runs inside an agent-sh session", async () => {
  const llm = await fakeLlm(() => ({ content: "nested ok" }));
  try {
    const r = await runCli(["-p", "hi"], llm.url, { env: { AGENT_SH: "1" } });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout.trim(), "nested ok");
  } finally { llm.server.close(); }
});

for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
  test(`${signal} during a request exits ${code}`, async () => {
    const llm = await fakeLlm(() => ({ hang: true }));
    try {
      const r = await runCli(["-p", "hi"], llm.url, {
        onSpawn: (child) => { void llm.requested.then(() => child.kill(signal)); },
      });
      assert.equal(r.code, code, r.stderr);
    } finally { llm.server.close(); }
  });
}

test("subagents extension fans out parallel scouts under -p", async () => {
  const llm = await fakeLlm((req) => {
    const system = String(req.messages[0]?.content ?? "");
    if (system.includes("scouting subagent")) return { content: `scouted: ${lastUser(req)}` };
    if (req.messages.some((m) => m.role === "tool")) return { content: "summary" };
    return toolCall("spawn_agent", { tasks: [{ agent: "scout", task: "area A" }, { agent: "scout", task: "area B" }] });
  });
  try {
    const r = await runCli(["-p", "scout two areas", "--output", "json", "-e", SUBAGENTS], llm.url);
    assert.equal(r.code, 0, r.stderr);
    const ev = events(r.stdout);
    assert.equal(ev.find((e) => e.type === "tool_start")?.name, "spawn_agent");
    const out = String(ev.find((e) => e.type === "tool_end")?.output);
    assert.match(out, /## \[1\] scout\n\nscouted: area A[\s\S]*## \[2\] scout\n\nscouted: area B/);
    assert.equal(ev.at(-1)?.response, "summary");
  } finally { llm.server.close(); }
});
