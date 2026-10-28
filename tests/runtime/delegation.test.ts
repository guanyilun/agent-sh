import test from "node:test";
import assert from "node:assert/strict";
import { createCore } from "../../src/core/index.js";
import { attachAgentSurface } from "../../src/agent/surface.js";
import { delegatedTools } from "../../src/runtime/delegation.js";
import type { ToolDefinition, ToolResult } from "../../src/agent/types.js";

const ok: ToolResult = { content: "ok", exitCode: 0, isError: false };

function parent() {
  const core = createCore({});
  const ctx = core.extensionContext({ quit() {} });
  const agent = attachAgentSurface(ctx);
  const calls: Array<{ name: string; id: string; args: Record<string, unknown>;
    tool: ToolDefinition; onChunk?: (chunk: string) => void; signal: AbortSignal }> = [];
  // Model the policy-aware loop dispatcher, using real named handler advice.
  ctx.define("tool:execute", async (input: typeof calls[number]) => {
    calls.push(input);
    return ctx.call(`tool:${input.name}`, input.args, input.onChunk, { signal: input.signal });
  });
  return { core, ctx, agent, calls };
}

function tool(name: string, execute: ToolDefinition["execute"] = async () => ok): ToolDefinition {
  return { name, description: `Tool ${name}`, input_schema: {
    type: "object", properties: { path: { type: "string" } }, required: ["path"],
  }, readOnly: true, execute };
}

test("delegation selects an explicit allowlist, validates names and copies schemas", t => {
  const p = parent();
  t.after(() => p.core.kill());
  const read = tool("read");
  p.agent.registerTool(read);
  p.agent.registerTool(tool("write"));
  p.agent.registerTool(tool("spawn_agent"));
  assert.deepEqual(delegatedTools(p.ctx, []), []);
  const selected = delegatedTools(p.ctx, ["read", "read"]);
  assert.deepEqual(selected.map(t => t.name), ["read"]);
  assert.equal(selected[0].description, read.description);
  assert.equal(selected[0].readOnly, true);
  assert.notEqual(selected[0], read);
  assert.deepEqual(selected[0].input_schema, read.input_schema);
  assert.notEqual(selected[0].input_schema, read.input_schema);
  (selected[0].input_schema.required as string[]).push("other");
  assert.deepEqual(read.input_schema.required, ["path"]);
  assert.throws(() => delegatedTools(p.ctx, ["read", "unknown"]), /unknown parent tool: unknown/);
  // Later mutation of the source allowlist cannot grant another capability.
  const names = ["read"];
  const fixed = delegatedTools(p.ctx, names);
  names.push("write");
  assert.deepEqual(fixed.map(t => t.name), ["read"]);
});

test("parent tool:execute denial prevents execution and named advice", async t => {
  const p = parent();
  t.after(() => p.core.kill());
  let executions = 0;
  let named = 0;
  p.agent.registerTool(tool("write", async () => { executions++; return ok; }));
  const [delegated] = delegatedTools(p.ctx, ["write"]);
  p.agent.adviseTool("write", async next => { named++; return next({}); });
  const denied: ToolResult = { content: "Policy denied", exitCode: 1, isError: true };
  p.ctx.advise("tool:execute", async () => denied);
  assert.equal(await delegated.execute({ path: "secret" }), denied);
  assert.equal(executions, 0);
  assert.equal(named, 0);
  assert.equal(p.calls.length, 0);
});

test("named tool advice can deny a delegated call independently", async t => {
  const p = parent();
  t.after(() => p.core.kill());
  let executions = 0;
  p.agent.registerTool(tool("read", async () => { executions++; return ok; }));
  const [delegated] = delegatedTools(p.ctx, ["read"]);
  p.agent.adviseTool("read", async () => { throw new Error("named policy denied"); });
  await assert.rejects(delegated.execute({ path: "secret" }), /named policy denied/);
  assert.equal(executions, 0);
  assert.equal(p.calls.length, 1);
});

test("delegation preserves named advice, parent schema, args, streaming and unique ids", async t => {
  const p = parent();
  t.after(() => p.core.kill());
  const chunks: string[] = [];
  const progress: Array<[string, string]> = [];
  const original = tool("read", async (_args, onChunk) => { onChunk?.("chunk"); return ok; });
  p.agent.registerTool(original);
  const [delegated] = delegatedTools(p.ctx, ["read"], {
    onProgress: (name, chunk) => progress.push([name, chunk]),
  });
  let advised = 0;
  p.agent.adviseTool("read", async (next, args, onChunk, context) => {
    advised++;
    const result = await next(args, onChunk, context);
    return { ...result, content: "advised" };
  });
  const args = { path: "file" };
  const child = new AbortController();
  assert.equal((await delegated.execute(args, chunk => chunks.push(chunk), { signal: child.signal })).content, "advised");
  await delegated.execute(args, undefined, { signal: child.signal });
  assert.equal(advised, 2);
  assert.deepEqual(chunks, ["chunk"]);
  assert.deepEqual(progress, [["read", "chunk"], ["read", "chunk"]]);
  assert.equal(p.calls[0].args, args);
  assert.equal(p.calls[0].signal, child.signal);
  assert.equal(p.calls[0].tool.name, original.name);
  assert.equal(p.calls[0].tool.execute, original.execute);
  assert.equal(p.calls[0].tool.input_schema, original.input_schema);
  assert.match(p.calls[0].id, /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/);
  assert.notEqual(p.calls[0].id, p.calls[1].id);
});

test("each execution forwards the child's live cancellation signal", async t => {
  const p = parent();
  t.after(() => p.core.kill());
  p.agent.registerTool(tool("wait", async (_args, _onChunk, context) => {
    const signal = context!.signal!;
    signal.throwIfAborted();
    return new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  }));
  const [delegated] = delegatedTools(p.ctx, ["wait"]);
  const child = new AbortController();
  const reason = new Error("child cancelled");
  const pending = delegated.execute({}, undefined, { signal: child.signal });
  child.abort(reason);
  await assert.rejects(pending, error => error === reason);
  assert.equal(p.calls[0].signal, child.signal);
  const nextChild = new AbortController();
  nextChild.abort(new Error("already cancelled"));
  await assert.rejects(delegated.execute({}, undefined, { signal: nextChild.signal }), /already cancelled/);
  assert.equal(p.calls[1].signal, nextChild.signal);
});

test("missing policy dispatcher rejects rather than falling back to dispatch or execute", async t => {
  const core = createCore({});
  t.after(() => core.kill());
  const ctx = core.extensionContext({ quit() {} });
  let executions = 0;
  // An alternate backend may contribute a catalog without installing the ash
  // surface (which now always installs a policy-aware bootstrap dispatcher).
  ctx.bus.onPipe("agent:tools", acc => { acc.tools.push(tool("read", async () => { executions++; return ok; })); return acc; });
  ctx.define("tool:dispatch", async () => { executions++; return ok; });
  const [delegated] = delegatedTools(ctx, ["read"]);
  await assert.rejects(delegated.execute({}), /parent tool:execute dispatcher is unavailable/);
  assert.equal(executions, 0);
});
