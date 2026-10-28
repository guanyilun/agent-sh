import test from "node:test";
import assert from "node:assert/strict";
import { createAgentHost, ashEngine, createProcessToolExecutor } from "../../src/runtime/index.js";
import type { LlmClient, StreamOpts } from "../../src/agent/llm-client.js";
import type { ToolDefinition } from "../../src/agent/types.js";

const tool: ToolDefinition = {
  name: "inspect", description: "inspect", input_schema: { type: "object", properties: {} },
  execute: async () => { throw new Error("controller tool body must never execute"); },
};

test("native engine dispatches through process boundary inside host policy and awaits worker teardown", async () => {
  const executor = createProcessToolExecutor({
    command: process.execPath,
    args: ["-e", `const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',line=>{const r=JSON.parse(line);if(r.type==='execute')process.stdout.write(JSON.stringify({id:r.id,type:'result',result:{content:'worker inspected',isError:false,exitCode:0}})+'\\n')});`],
    env: {},
  });
  let calls = 0;
  let deny = true;
  const model = {
    model: "fake",
    async stream(opts: StreamOpts) {
      calls++;
      const hasResult = opts.messages.some(m => m.role === "tool");
      return (async function* () {
        yield { choices: [{ delta: hasResult ? { content: "done" } : {
          tool_calls: [{ index: 0, id: "t1", function: { name: "inspect", arguments: "{}" } }],
        } }] };
      })();
    },
  } as unknown as LlmClient;
  const host = await createAgentHost({ cwd: process.cwd(), extensions: [
    ashEngine({ client: model, tools: [tool], executor: executor.dispatch }),
    { name: "policy", activate(ctx) {
      ctx.advise("tool:execute", (next, call) => deny
        ? { content: "denied", isError: true, exitCode: 1 }
        : next(call));
      ctx.onDispose(() => executor.dispose());
    } },
  ] });
  try {
    const denied = await host.run("inspect", { maxIterations: 2 });
    assert.match(JSON.stringify(denied.details?.messages), /denied/);
    await host.restore({ version: 1, messages: [] });
    deny = false;
    const allowed = await host.run("inspect", { maxIterations: 2 });
    assert.match(JSON.stringify(allowed.details?.messages), /worker inspected/);
    assert.equal(calls, 4);
  } finally { await host.dispose(); }
  await assert.rejects(executor.dispatch({ name: "inspect", args: {}, tool, context: {} }), /disposed|closed|exited/);
});
