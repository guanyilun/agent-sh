/** `agent-sh -p` end to end against a local fake OpenAI-compatible server. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { events, fakeLlm, lastUser, runCli, SUBAGENTS, toolCall } from "./fake-llm.js";

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
    if (system.includes("exploring subagent")) return { content: `scouted: ${lastUser(req)}` };
    if (req.messages.some((m) => m.role === "tool")) return { content: "summary" };
    return toolCall("spawn_agent", { tasks: [{ agent: "scout", task: "area A" }, { agent: "scout", task: "area B" }] });
  });
  try {
    const r = await runCli(["-p", "scout two areas", "--output", "json", "-e", SUBAGENTS], llm.url);
    assert.equal(r.code, 0, r.stderr);
    const ev = events(r.stdout);
    assert.equal(ev.find((e) => e.type === "tool_start")?.name, "spawn_agent");
    const progress = ev.filter((e) => e.type === "tool_output").map((e) => e.chunk).join("");
    assert.match(progress, /\[1 scout\] done/);
    assert.match(progress, /\[2 scout\] done/);
    const out = String(ev.find((e) => e.type === "tool_end")?.output);
    assert.match(out, /## \[1\] scout\n\nscouted: area A[\s\S]*## \[2\] scout\n\nscouted: area B/);
    assert.equal(ev.at(-1)?.response, "summary");
  } finally { llm.server.close(); }
});

test("--no-stdin ignores piped stdin", async () => {
  const llm = await fakeLlm(() => ({ content: "ok" }));
  try {
    const r = await runCli(["-p", "just this", "--no-stdin"], llm.url, { stdin: "SHOULD NOT APPEAR" });
    assert.equal(r.code, 0, r.stderr);
    assert.doesNotMatch(lastUser(llm.requests[0]!), /SHOULD NOT APPEAR/);
    assert.match(lastUser(llm.requests[0]!), /just this/);
  } finally { llm.server.close(); }
});

test("--print= passes a prompt that starts with a dash", async () => {
  const llm = await fakeLlm(() => ({ content: "ok" }));
  try {
    const r = await runCli(["--print=-ls this directory"], llm.url);
    assert.equal(r.code, 0, r.stderr);
    assert.match(lastUser(llm.requests[0]!), /-ls this directory/);
  } finally { llm.server.close(); }
});

test("a reader that closes stdout early ends the run without a crash", async () => {
  const llm = await fakeLlm(() => ({ content: "x".repeat(200_000) }));
  try {
    const r = await runCli(["-p", "hi"], llm.url, { onSpawn: (child) => child.stdout!.destroy() });
    assert.equal(r.code, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /EPIPE|Error/);
  } finally { llm.server.close(); }
});

test("a user .ts workflow with a typed step runs under -p", async () => {
  const llm = await fakeLlm((req) => {
    const system = String(req.messages[0]?.content ?? "");
    if (req.stream === undefined || req.stream === false) return { content: '{"ok": true}' };
    if (system.includes("focused subagent")) return toolCall("submit_result", { ok: true });
    if (req.messages.some((m) => m.role === "tool")) return { content: "done" };
    return toolCall("run_workflow", { name: "typed" });
  });
  try {
    const r = await runCli(["-p", "run typed", "--output", "json", "-e", SUBAGENTS], llm.url, {
      prepare: (home) => {
        mkdirSync(join(home, ".agent-sh", "workflows"), { recursive: true });
        // Real TypeScript syntax in a dir with no package.json: the case that broke on Node 20.
        writeFileSync(join(home, ".agent-sh", "workflows", "typed.ts"), [
          'import type { WorkflowApi } from "agent-sh-subagents";',
          "export default async ({ run }: WorkflowApi): Promise<string> => {",
          '  const r: { ok: boolean } = await run({ task: "check", tools: [], schema: { ok: { type: "boolean" } } });',
          '  return r.ok ? "typed ok" : "typed no";',
          "};",
        ].join("\n"));
      },
    });
    assert.equal(r.code, 0, r.stderr);
    const ev = events(r.stdout);
    assert.equal(ev.find((e) => e.type === "tool_start")?.name, "run_workflow");
    assert.match(String(ev.find((e) => e.type === "tool_end")?.output), /^typed ok\n\n\(workflow run \S+; log: .*workflow-runs/);
    assert.match(ev.filter((e) => e.type === "tool_output").map((e) => e.chunk).join(""), /\[1 ad-hoc\] submit_result\n\[1 ad-hoc\] done/);
    assert.equal(llm.requests.filter((q) => !q.stream).length, 0);
  } finally { llm.server.close(); }
});

test("-p stays alive for a background run and exits after the wake turn reads it", async () => {
  const llm = await fakeLlm((req) => {
    const system = String(req.messages[0]?.content ?? "");
    if (system.includes("exploring subagent")) return { content: "scouted the area" };
    const last = req.messages.at(-1)!;
    const lastText = String(last.content);
    if (last.role === "tool" && lastText.includes("Started background run #1")) return { content: "started it" };
    if (last.role === "tool" && lastText.includes("Run #1 (scout) done")) return { content: "final: scouted the area" };
    if (lastText.includes("[background] Finished: #1 scout (done)")) return toolCall("subagent_jobs", { action: "result", id: 1 });
    return toolCall("spawn_agent", { agent: "scout", task: "map it", background: true });
  });
  try {
    const r = await runCli(["-p", "scout in the background", "--output", "json", "-e", SUBAGENTS], llm.url);
    assert.equal(r.code, 0, r.stderr);
    const ev = events(r.stdout);
    assert.deepEqual(ev.filter((e) => e.type === "tool_start").map((e) => e.name), ["spawn_agent", "subagent_jobs"]);
    assert.equal(ev.at(-1)?.type, "done");
    assert.equal(ev.at(-1)?.response, "final: scouted the area");
  } finally { llm.server.close(); }
});

test("a single-file .ts extension with ESM syntax loads from an untyped extensions dir", async () => {
  const llm = await fakeLlm(() => ({ content: "ok" }));
  try {
    const r = await runCli(["-p", "hi", "--output", "json"], llm.url, {
      prepare: (home) => {
        mkdirSync(join(home, ".agent-sh", "extensions"), { recursive: true });
        writeFileSync(join(home, ".agent-sh", "extensions", "probe.ts"), [
          'import type { AgentContext } from "agent-sh/types";',
          "export default function activate(ctx: AgentContext): void {",
          '  ctx.agent.registerTool({ name: "probe_tool", description: "probe", input_schema: { type: "object", properties: {} },',
          '    execute: async () => ({ content: "x", exitCode: 0, isError: false }) });',
          "}",
        ].join("\n"));
      },
    });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(events(r.stdout).filter((e) => e.type === "notice" && e.level === "error"), []);
    assert.ok(llm.requests[0]!.tools!.some((t) => t.function.name === "probe_tool"));
  } finally { llm.server.close(); }
});
