/** Shared by CLI tests: a local fake OpenAI-compatible server and a runner for the built CLI. */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const CLI = fileURLToPath(new URL("../../dist/cli/index.js", import.meta.url));
export const SUBAGENTS = fileURLToPath(new URL("../../examples/extensions/subagents", import.meta.url));

export interface ChatRequest { messages: { role: string; content: unknown }[]; tools?: { function: { name: string } }[]; stream?: boolean }
export type Reply = Record<string, unknown> | { status: number } | { hang: true };

export async function fakeLlm(reply: (req: ChatRequest) => Reply): Promise<{ url: string; requests: ChatRequest[]; requested: Promise<void>; server: Server }> {
  const requests: ChatRequest[] = [];
  let onRequest!: () => void;
  const requested = new Promise<void>((r) => { onRequest = r; });
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      if (req.url?.endsWith("/chat/completions") && !JSON.parse(body).stream) {
        const parsed = JSON.parse(body) as ChatRequest;
        requests.push(parsed);
        const r = reply(parsed) as { content?: string };
        res.writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: r.content ?? "" }, finish_reason: "stop" }] }));
        return;
      }
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

export interface RunOpts {
  stdin?: string;
  env?: Record<string, string>;
  onSpawn?: (child: ChildProcess) => void;
  prepare?: (home: string) => void;
  home?: string;
  keepHome?: boolean;
}

export function runCli(args: string[], url: string, opts: RunOpts = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const home = opts.home ?? mkdtempSync(join(tmpdir(), "agent-sh-headless-"));
  opts.prepare?.(home);
  return new Promise((resolve) => {
    const child = spawn("node", [CLI, ...args, "--api-key", "test", "--base-url", url, "--model", "fake"], {
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
      if (!opts.keepHome) rmSync(home, { recursive: true, force: true });
      resolve({ code, stdout, stderr });
    });
  });
}

export const events = (stdout: string) => stdout.trim().split("\n").map((l) => JSON.parse(l) as Record<string, any>);
export const lastUser = (req: ChatRequest) => String([...req.messages].reverse().find((m) => m.role === "user")?.content ?? "");
export const toolCall = (name: string, args: unknown) => ({
  tool_calls: [{ index: 0, id: `call_${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } }],
});

