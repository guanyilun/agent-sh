/** subagents extension: agent discovery/overrides, parallel fan-out, and
 *  tool calls routed through adviseTool wrappers. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../../src/core/event-bus.js";
import { HandlerRegistry } from "../../src/utils/handler-registry.js";
import type { ToolDefinition, ToolSchemaView } from "../../src/agent/types.js";
import activate from "../../examples/extensions/subagents/index.js";
import { parseAgent } from "../../examples/extensions/subagents/agents.js";

type StreamOpts = { messages: { role: string; content: string }[]; tools?: { function: { name: string } }[] };

const lastUser = (o: StreamOpts) => String([...o.messages].reverse().find((m) => m.role === "user")?.content ?? "");

function setup(reply: (opts: StreamOpts) => Record<string, unknown>) {
  const root = mkdtempSync(join(tmpdir(), "subagents-"));
  const project = join(root, "project");
  mkdirSync(join(project, ".agent-sh", "agents"), { recursive: true });

  const bus = new EventBus();
  const h = new HandlerRegistry();
  const calls: StreamOpts[] = [];
  h.define("cwd", () => project);
  h.define("agent:get-models", () => []);
  h.define("llm:get-client", () => ({
    model: "stub",
    stream: async (opts: StreamOpts) => {
      calls.push(opts);
      const delta = reply(opts);
      return (async function* () { yield { choices: [{ delta }] }; })();
    },
  }));

  const tools: ToolDefinition[] = [];
  let schemaAdvisor: ((next: () => ToolSchemaView) => ToolSchemaView) | undefined;
  const register = (t: ToolDefinition) => { tools.push(t); h.define(`tool:${t.name}`, t.execute.bind(t)); };
  for (const name of ["read_file", "grep", "bash"]) {
    register({
      name,
      description: name,
      input_schema: { type: "object", properties: {} },
      execute: async () => ({ content: `${name} ran`, exitCode: 0, isError: false }),
    });
  }

  const ctx = {
    bus,
    define: h.define.bind(h),
    advise: h.advise.bind(h),
    call: h.call.bind(h),
    getExtensionSettings: (_ns: string, d: object) => d,
    getStoragePath: (ns: string) => { const p = join(root, ns); mkdirSync(p, { recursive: true }); return p; },
    registerCommand: () => {},
    agent: {
      registerInstruction: () => {},
      registerTool: register,
      getTools: () => tools,
      adviseToolSchema: (_n: string, a: typeof schemaAdvisor) => { schemaAdvisor = a; return () => {}; },
    },
  };
  activate(ctx as never);

  const spawn = tools.find(t => t.name === "spawn_agent")!;
  return {
    calls,
    h,
    project,
    run: (args: Record<string, unknown>, onChunk?: (chunk: string) => void) => spawn.execute(args, onChunk, {}),
    description: () => schemaAdvisor!(() => ({ description: spawn.description, parameters: spawn.input_schema })).description,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("parseAgent reads frontmatter and maps pi tool names", () => {
  const def = parseAgent("---\nname: x\ndescription: d\ntools: read, find, bash\nmaxIterations: 7\ninheritContext: true\n---\nPrompt body\n", "/a/x.md");
  assert.deepEqual(def && { ...def, source: undefined }, {
    name: "x", description: "d", systemPrompt: "Prompt body",
    tools: ["read_file", "glob", "bash"], model: undefined, thinking: undefined,
    maxIterations: 7, inheritContext: true, source: undefined,
  });
  assert.equal(parseAgent("no frontmatter", "/a/y.md"), null);
});

test("project agents override bundled ones and are advertised", async () => {
  const s = setup(() => ({ content: "ok" }));
  try {
    writeFileSync(join(s.project, ".agent-sh", "agents", "scout.md"),
      "---\ndescription: project scout\ntools: grep\n---\nPROJECT SCOUT PROMPT");
    assert.match(s.description(), /- scout: project scout/);
    assert.match(s.description(), /- reviewer: /);

    await s.run({ agent: "scout", task: "find it" });
    assert.match(s.calls[0]!.messages[0]!.content, /PROJECT SCOUT PROMPT/);
    assert.deepEqual(s.calls[0]!.tools!.map(t => t.function.name), ["grep"]);
  } finally { s.cleanup(); }
});

test("unknown agents are rejected before anything runs", async () => {
  const s = setup(() => ({ content: "ok" }));
  try {
    const r = await s.run({ agent: "nope", task: "t" });
    assert.equal(r.isError, true);
    assert.match(String(r.content), /Unknown agent: nope/);
    assert.equal(s.calls.length, 0);
  } finally { s.cleanup(); }
});

test("parallel tasks return one section per task in order", async () => {
  const s = setup((o) => ({ content: `answer to ${o.messages.at(-1)!.content}` }));
  try {
    const r = await s.run({ tasks: [{ agent: "reviewer", task: "A" }, { task: "B", tools: ["grep"] }] });
    assert.equal(r.isError, false);
    assert.match(String(r.content), /## \[1\] reviewer\n\nanswer to A[\s\S]*## \[2\] ad-hoc\n\nanswer to B/);
    assert.ok(s.calls.every(c => !c.tools?.some(t => t.function.name === "spawn_agent")));
  } finally { s.cleanup(); }
});

test("subagent tool calls go through adviseTool wrappers", async () => {
  let turn = 0;
  const s = setup(() => turn++ === 0
    ? { tool_calls: [{ index: 0, id: "c1", function: { name: "grep", arguments: "{}" } }] }
    : { content: "done" });
  try {
    const seen: string[] = [];
    s.h.advise("tool:grep", async (next: (...a: unknown[]) => Promise<unknown>, ...a: unknown[]) => {
      seen.push("advised");
      return next(...a);
    });
    const r = await s.run({ task: "search", tools: ["grep"] });
    assert.equal(r.content, "done");
    assert.deepEqual(seen, ["advised"]);
  } finally { s.cleanup(); }
});

test("streams one progress line per subagent step and a closing status", async () => {
  const s = setup((o) => o.messages.some((m) => m.role === "tool")
    ? { content: "found" }
    : { tool_calls: [{ index: 0, id: "c1", function: { name: "grep", arguments: JSON.stringify({ pattern: lastUser(o) }) } }] });
  try {
    let out = "";
    await s.run({ tasks: [{ task: "alpha", tools: ["grep"] }, { agent: "scout", task: "beta" }] }, (c) => { out += c; });
    const lines = out.trim().split("\n").sort();
    assert.deepEqual(lines, [
      "[1 ad-hoc] done",
      "[1 ad-hoc] grep: alpha",
      "[2 scout] done",
      "[2 scout] grep: beta",
    ]);
  } finally { s.cleanup(); }
});

test("reports a subagent that hits its step limit", async () => {
  const s = setup(() => ({ tool_calls: [{ index: 0, id: "c1", function: { name: "grep", arguments: "{}" } }] }));
  try {
    writeFileSync(join(s.project, ".agent-sh", "agents", "looper.md"), "---\ntools: grep\nmaxIterations: 2\n---\nloop");
    let out = "";
    await s.run({ agent: "looper", task: "go" }, (c) => { out += c; });
    assert.match(out, /\[looper\] stopped: step limit reached\n$/);
  } finally { s.cleanup(); }
});
