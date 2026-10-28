import test from "node:test";
import assert from "node:assert/strict";
import { createCore } from "../../src/core/index.js";
import { createScopedContext } from "../../src/core/extension-loader.js";
import { attachAgentSurface } from "../../src/agent/surface.js";
import { delegatedTools } from "../../src/runtime/delegation.js";
import type { ToolDefinition, ToolResult } from "../../src/agent/types.js";

const ok: ToolResult = { content: "ok", exitCode: 0, isError: false };
const tool = (execute: ToolDefinition["execute"]): ToolDefinition => ({
  name: "read", description: "Read", input_schema: {
    type: "object", properties: { path: { type: "string" } }, required: ["path"],
  }, execute,
});

function parent(t: { after(fn: () => void): void }) {
  const core = createCore({});
  t.after(() => core.kill());
  const ctx = core.extensionContext({ quit() {} });
  return { ctx, agent: attachAgentSurface(ctx) };
}

test("surface-only delegation executes through policy, dispatch and named advice", async t => {
  const core = createCore({});
  t.after(() => core.kill());
  const ctx = core.extensionContext({ quit() {} });
  const order: string[] = [];
  // Reproduce the advice-only entry that previously masqueraded as a dispatcher.
  ctx.advise("tool:execute", async (next, input) => {
    order.push("policy");
    return next(input);
  });
  const agent = attachAgentSurface(ctx);
  const controller = new AbortController();
  const args = { path: "file" };
  agent.registerTool(tool(async (received, onChunk, context) => {
    order.push("execute");
    assert.equal(received, args);
    assert.equal(context?.signal, controller.signal);
    onChunk?.("chunk");
    return ok;
  }));
  ctx.advise("tool:dispatch", (next, input) => { order.push("dispatch"); return next(input); });
  agent.adviseTool("read", async (next, ...args) => {
    order.push("named");
    return { ...await next(...args), content: "advised" };
  });
  const [delegated] = delegatedTools(ctx, ["read"]);
  const chunks: string[] = [];
  assert.equal((await delegated.execute(args, chunk => chunks.push(chunk), { signal: controller.signal })).content, "advised");
  assert.deepEqual(chunks, ["chunk"]);
  assert.deepEqual(order, ["policy", "dispatch", "named", "execute"]);
});

test("surface-only policy denial never reaches dispatch or the named tool", async t => {
  const { ctx, agent } = parent(t);
  agent.registerTool(tool(async () => { assert.fail("executed"); }));
  agent.adviseTool("read", () => { assert.fail("named advice ran"); });
  ctx.advise("tool:dispatch", () => { assert.fail("dispatched"); });
  const denied: ToolResult = { content: "denied", exitCode: 1, isError: true };
  ctx.advise("tool:execute", async () => denied);
  const [delegated] = delegatedTools(ctx, ["read"]);
  assert.equal(await delegated.execute({ path: "file" }), denied);
});

test("surface-only cancelled delegation never dispatches", async t => {
  const { ctx, agent } = parent(t);
  agent.registerTool(tool(async () => { assert.fail("executed"); }));
  ctx.advise("tool:dispatch", () => { assert.fail("dispatched"); });
  const [delegated] = delegatedTools(ctx, ["read"]);
  const controller = new AbortController();
  const reason = new Error("cancelled");
  controller.abort(reason);
  await assert.rejects(delegated.execute({ path: "file" }, undefined, { signal: controller.signal }), error => error === reason);
});

test("bootstrap validates current catalog and arguments, never a supplied implementation", async t => {
  const { ctx, agent } = parent(t);
  let executions = 0;
  agent.registerTool(tool(async () => { executions++; return ok; }));
  const [delegated] = delegatedTools(ctx, ["read"]);
  assert.equal((await delegated.execute({})).isError, true);
  const input = {
    name: "read", args: { path: "file" }, signal: new AbortController().signal,
    tool: tool(async () => { assert.fail("caller implementation ran"); }),
  };
  await assert.rejects(ctx.call("tool:execute", { ...input, args: [] }), /expected an object/);
  await assert.rejects(ctx.call("tool:execute", { ...input, name: "other" }), /must match/);
  assert.equal(await ctx.call("tool:execute", input), ok);
  assert.equal(executions, 1);
  agent.unregisterTool("read");
  await assert.rejects(delegated.execute({ path: "file" }), /unavailable/);
  await assert.rejects(ctx.call("tool:dispatch", { ...input, context: { signal: input.signal } }), /unavailable/);
  agent.registerTool(tool(async () => ({ ...ok, content: "replacement" })));
  assert.equal((await delegated.execute({ path: "file" })).content, "replacement");
});

test("surface installed from a scope retains host-lifetime dispatch after scope disposal", async t => {
  const core = createCore({});
  t.after(() => core.kill());
  const ctx = core.extensionContext({ quit() {} });
  const scope = createScopedContext(ctx, "installer");
  const agent = attachAgentSurface(scope.scoped);
  scope.dispose();
  assert.equal(attachAgentSurface(ctx), agent);
  agent.registerTool(tool(async () => ok));
  const [delegated] = delegatedTools(ctx, ["read"]);
  assert.equal(await delegated.execute({ path: "file" }), ok);
});

test("replacing the execute base preserves policy and the bootstrap dispatch contract", async t => {
  const { ctx, agent } = parent(t);
  let policy = 0;
  agent.registerTool(tool(async () => ok));
  ctx.advise("tool:execute", (next, input) => { policy++; return next(input); });
  // The loop replaces this base and passes the same AgentToolDispatchInput shape.
  ctx.define("tool:execute", input => ctx.call("tool:dispatch", {
    ...input, context: { signal: input.signal },
  }));
  attachAgentSurface(ctx);
  const [delegated] = delegatedTools(ctx, ["read"]);
  assert.equal(await delegated.execute({ path: "file" }), ok);
  assert.equal(policy, 1);
});
