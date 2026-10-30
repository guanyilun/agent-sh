/** Run from the repository: node --import tsx examples/programmatic-agent.ts
 * The real ash engine, with only model transport faked. No network or credentials. */
import assert from "node:assert/strict";
import { ashEngine, createAgentHost, delegatedTools, type HostExtension } from "../src/runtime/index.js";
import type { LlmClient, StreamOpts } from "../src/agent/llm-client.js";
import type { ToolDefinition } from "../src/agent/types.js";

// Emit OpenAI-shaped streamed deltas: tool call, then a response using the tool
// result. History is inspected per turn, so snapshot/restore needs no fake state.
function scriptedClient() {
  const requests: StreamOpts[] = [];
  const transport = {
    model: "scripted-model",
    async stream(options: StreamOpts) {
      requests.push(structuredClone({ ...options, signal: undefined }));
      const lastUser = options.messages.map(message => message.role).lastIndexOf("user");
      const query = options.messages[lastUser]?.content;
      assert.equal(typeof query, "string");
      assert.ok(options.tools?.some(tool => tool.type === "function" && tool.function.name === "inspect"));
      const result = options.messages.slice(lastUser + 1).find(message => message.role === "tool");
      return (async function* () {
        yield { choices: [{ delta: result
          ? { content: `Model saw: ${result.content}` }
          : { tool_calls: [{ index: 0, id: "inspect-call", type: "function", function: {
            name: "inspect", arguments: JSON.stringify({ path: query }),
          } }] }, finish_reason: result ? "stop" : "tool_calls" }] };
        yield { choices: [], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } };
      })();
    },
  };
  // The engine uses stream() here; this deliberately supplies no real SDK client.
  return { client: transport as unknown as LlmClient, requests };
}

let executions = 0;
let denied = 0;
const disposed: string[] = [];
const inspect: ToolDefinition = {
  name: "inspect",
  description: "Inspect a symbolic path (does not access the filesystem).",
  input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  readOnly: true,
  async execute(args) {
    executions++;
    return { content: `inspected ${args.path}`, exitCode: 0, isError: false };
  },
};

function rules(label: string): HostExtension {
  return {
    name: `rules-${label}`,
    activate(ctx) {
      ctx.agent!.registerInstruction("rules", "Use inspect to answer the user's query.");
      ctx.agent!.adviseTool("inspect", async (next, ...args) => {
        const result = await next(...args);
        return { ...result, content: `[${ctx.call("cwd")}] ${result.content}` };
      });
      ctx.onDispose(() => { disposed.push(label); });
    },
  };
}

const parentTransport = scriptedClient();
const childTransport = scriptedClient();
const parent = await createAgentHost({
  cwd: "/workspace/parent", // Symbolic: this demo never touches these paths.
  settings: { autoCompact: false, toolMode: "api" },
  extensions: [
    ashEngine({ client: parentTransport.client, tools: [inspect], ambientContext: false }),
    rules("parent"),
    {
      name: "parent-policy",
      activate(ctx) {
        // The outer boundary also applies to delegated child calls. Filtering a
        // child's tool schemas alone would not enforce this argument policy.
        ctx.advise("tool:execute", (next, call) => {
          if (call.name === "inspect" && call.args.path === "secret") {
            denied++;
            return { content: "Parent policy denied secret", exitCode: 1, isError: true };
          }
          return next(call);
        });
      },
    },
  ],
});

try {
  const child = await parent.createChild({
    cwd: "/workspace/child",
    extensions: [
      ashEngine({ client: childTransport.client, ambientContext: false,
        tools: delegatedTools(parent.context, ["inspect"]) }),
      rules("child"),
    ],
  });
  child.settings.setSessionOverlay({ thinkingLevel: "high" });
  assert.notEqual(parent.settings.get().thinkingLevel, "high");
  assert.notEqual(parent.id, child.id);

  const [first, second] = await Promise.all([
    parent.run("README.md", { maxIterations: 3 }),
    child.run("tests", { maxIterations: 3 }),
  ]);
  assert.equal(first.status, "completed");
  assert.equal(second.status, "completed");
  assert.equal(first.details?.iterations, 2);
  assert.equal(first.usage.total_tokens, 12);
  assert.match(first.text, /\[\/workspace\/parent\] inspected README.md/);
  assert.match(second.text, /\[\/workspace\/child\] \[\/workspace\/parent\] inspected tests/);
  assert.match(JSON.stringify(parentTransport.requests[0].messages), /Use inspect/);
  console.log(first.text);
  console.log(second.text);

  const saved = await parent.snapshot();
  assert.equal(saved.version, 1);
  await parent.run("src", { maxIterations: 3 });
  assert.notDeepEqual(await parent.snapshot(), saved);
  await parent.restore(saved);
  assert.deepEqual(await parent.snapshot(), saved);
  console.log("Snapshot restored after a follow-up turn.");

  const before = executions;
  const rejected = await child.run("secret", { maxIterations: 3 });
  // A denied tool result is recorded and the model can finish normally. It is
  // not automatically a failed run; thrown tool errors are a separate option.
  assert.equal(rejected.status, "completed");
  assert.equal(denied, 1);
  assert.equal(executions, before);
  assert.match(rejected.text, /Parent policy denied secret/);
  assert.ok(rejected.details?.messages.some(message => message.role === "tool"
    && String(message.content).includes("Parent policy denied secret")));
  console.log(rejected.text);

  await parent.dispose(); // Owns and disposes the explicitly composed child too.
  await parent.dispose(); // Idempotent.
  assert.deepEqual(disposed, ["child", "parent"]);
  await assert.rejects(parent.run("after disposal"), /disposed/);
  await assert.rejects(child.run("after disposal"), /disposed/);
  console.log("Both hosts disposed; further runs rejected. All assertions passed.");
} finally {
  await parent.dispose();
}
