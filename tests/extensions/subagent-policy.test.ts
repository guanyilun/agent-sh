import test from "node:test";
import assert from "node:assert/strict";
import { setup } from "./subagents-harness.js";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCore } from "../../src/core/index.js";
import { attachAgentSurface } from "../../src/agent/surface.js";
import activate from "../../examples/extensions/subagents/index.js";

test("subagents cross parent tool:execute policy before named-tool advice", async () => {
  let turn = 0;
  const seen: string[] = [];
  const s = setup({
    reply: () => turn++ === 0
      ? { tool_calls: [{ index: 0, id: "child-call", function: { name: "grep", arguments: "{}" } }] }
      : { content: "done" },
    before: h => {
      h.define("tool:execute", async (input: { name: string; args: unknown; onChunk: unknown; signal: AbortSignal }) => {
        seen.push("policy");
        assert.ok(input.signal instanceof AbortSignal);
        return h.call(`tool:${input.name}`, input.args, input.onChunk, { signal: input.signal });
      });
      h.advise("tool:grep", async (next, ...args) => { seen.push("named advice"); return next(...args); });
    },
  });
  try {
    const result = await s.run({ task: "search", tools: ["grep"] });
    assert.equal(result.content, "done");
    assert.deepEqual(seen, ["policy", "named advice"]);
  } finally { s.cleanup(); }
});

test("a real context without a policy dispatcher never uses the legacy named-handler fallback", async () => {
  const root = mkdtempSync(join(tmpdir(), "subagent-policy-"));
  const core = createCore({});
  const ctx = core.extensionContext({ quit() {} });
  const agent = attachAgentSurface(ctx);
  // Model an alternate host that intentionally exposes no dispatcher. Ash
  // surfaces now install a valid bootstrap base even before backend startup.
  const visibleHandlers = ctx.list;
  ctx.list = () => visibleHandlers().filter(name => name !== "tool:execute");
  let rawExecuted = false;
  core.handlers.define("cwd", () => root);
  core.handlers.define("llm:get-client", () => ({
    model: "stub",
    stream: async () => (async function* () {
      yield { choices: [{ delta: { tool_calls: [{ index: 0, id: "c", function: { name: "grep", arguments: "{}" } }] } }] };
    })(),
  }));
  agent.registerTool({
    name: "grep", description: "search", input_schema: {},
    execute: async () => { rawExecuted = true; return { content: "bypassed", exitCode: 0, isError: false }; },
  });
  try {
    assert.ok(ctx.instanceId);
    assert.ok(!ctx.list().includes("tool:execute"));
    activate({ ...ctx, agent, getStoragePath: namespace => {
      const dir = join(root, namespace);
      mkdirSync(dir, { recursive: true });
      return dir;
    } });
    const result = await ctx.call("tool:spawn_agent", { task: "search", tools: ["grep"] });
    assert.equal(rawExecuted, false);
    assert.equal(result.isError, true);
    assert.match(result.content, /parent tool:execute dispatcher is unavailable/);
  } finally {
    await core.kill();
    rmSync(root, { recursive: true, force: true });
  }
});

test("parent policy denial cannot fall back to named handlers", async () => {
  let turn = 0;
  let rawExecuted = false;
  const s = setup({
    reply: () => turn++ === 0
      ? { tool_calls: [{ index: 0, id: "child-call", function: { name: "grep", arguments: "{}" } }] }
      : { content: "denied" },
    before: h => {
      h.define("tool:execute", () => ({ content: "policy denied", exitCode: 1, isError: true }));
      h.advise("tool:grep", async (next, ...args) => { rawExecuted = true; return next(...args); });
    },
  });
  try {
    await s.run({ task: "search", tools: ["grep"] });
    assert.equal(rawExecuted, false);
    assert.match(JSON.stringify(s.calls[1].messages), /policy denied/);
  } finally { s.cleanup(); }
});
