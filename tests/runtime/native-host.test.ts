import test from "node:test";
import assert from "node:assert/strict";
import { createAgentHost, ashEngine, localTools } from "../../src/runtime/index.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LlmClient, StreamOpts } from "../../src/agent/llm-client.js";

function client() {
  const requests: StreamOpts[] = [];
  const fake = {
    model: "test-model",
    async stream(options: StreamOpts) {
      requests.push(options);
      return (async function* () {
        yield { choices: [{ delta: { content: "hello" } }] };
        yield { choices: [], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } };
      })();
    },
  } as unknown as LlmClient;
  return { fake, requests };
}

test("native host uses callable full engine, extensions and versioned snapshots", async () => {
  const { fake, requests } = client();
  const host = await createAgentHost({
    cwd: process.cwd(),
    extensions: [ashEngine({ client: fake }), {
      name: "rules",
      activate(ctx) {
        ctx.agent!.registerInstruction("test", "Obey this special instruction.");
        ctx.agent!.registerContextProducer("test", () => "dynamic test context");
      },
    }],
  });
  try {
    const result = await host.run("first");
    assert.equal(result.status, "completed");
    assert.equal(result.text, "hello");
    assert.ok(result.details?.runId);
    assert.match(JSON.stringify(requests[0].messages), /Obey this special instruction/);
    assert.match(JSON.stringify(requests[0].messages), /dynamic test context/);
    const snapshot = await host.snapshot();
    assert.equal(snapshot.version, 1);
    await host.run("second");
    await host.restore(snapshot);
    assert.deepEqual(await host.snapshot(), snapshot);
    host.settings.setSessionOverlay({ thinkingLevel: "high" });
  } finally { await host.dispose(); }
});

test("parent owns child lifecycle without inheriting mutable settings", async () => {
  const parent = await createAgentHost({ cwd: process.cwd(), extensions: [ashEngine({ client: client().fake })] });
  const child = await parent.createChild({ cwd: process.cwd(), extensions: [ashEngine({ client: client().fake })] });
  child.settings.setSessionOverlay({ thinkingLevel: "high" });
  assert.notEqual(parent.settings.get().thinkingLevel, "high");
  await parent.dispose();
  await assert.rejects(child.run("after disposal"), /disposed/);
});

test("native cancel before engine startup prevents a model request", async () => {
  const { fake, requests } = client();
  const host = await createAgentHost({ cwd: process.cwd(), extensions: [ashEngine({ client: fake })] });
  try {
    const pending = host.run("cancel immediately");
    host.cancel();
    assert.equal((await pending).status, "cancelled");
    assert.equal(requests.length, 0);
  } finally { await host.dispose(); }
});

test("completion-boundary steering never starts an unowned turn", async () => {
  const { fake, requests } = client();
  const host = await createAgentHost({ cwd: process.cwd(), extensions: [ashEngine({ client: fake })] });
  try {
    let once = false;
    host.context.bus.on("agent:processing-done", () => {
      if (!once) { once = true; host.steer("too late"); }
    });
    await host.run("first");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(requests.length, 1);
  } finally { await host.dispose(); }
});

test("backend switching releases native callable handlers", async () => {
  const host = await createAgentHost({ cwd: process.cwd(), extensions: [ashEngine({ client: client().fake }), {
    name: "legacy", activate(ctx) {
      ctx.bus.emit("agent:register-backend", { name: "legacy", kill() {}, async start() {
        ctx.bus.on("agent:submit", () => {
          ctx.bus.emit("agent:response-done", { response: "legacy reply" });
          ctx.bus.emit("agent:processing-done", {});
        });
      } });
    },
  }] });
  try {
    host.context.bus.emit("config:switch-backend", { name: "legacy" });
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(!host.context.list().includes("agent:run"));
    assert.equal((await host.run("hi")).text, "legacy reply");
  } finally { await host.dispose(); }
});

test("pending child initialization does not block cancellation of existing children", { timeout: 3000 }, async () => {
  const parent = await createAgentHost({ cwd: process.cwd(), extensions: [ashEngine({ client: client().fake })] });
  const child = await parent.createChild({ cwd: process.cwd(), extensions: [ashEngine({ client: {
    model: "waiting", stream: () => new Promise(() => {}),
  } as unknown as LlmClient })] });
  const running = child.run("wait");
  const creating = parent.createChild({ cwd: process.cwd(), extensions: [
    { name: "await-sibling", activate: async () => { await running; } },
    ashEngine({ client: client().fake }),
  ] });
  const rejected = assert.rejects(creating, /Parent disposed/);
  await parent.dispose();
  await rejected;
  assert.equal((await running).status, "cancelled");
});

test("scoped provider replacement never exposes a transient missing catalog", async () => {
  const host = await createAgentHost({ cwd: process.cwd(), extensions: [ashEngine({ client: client().fake }), {
    name: "catalog", activate(ctx) {
      ctx.agent!.providers.register({ id: "p", models: ["first"] });
      const seen: string[][] = [];
      ctx.bus.on("agent:providers:changed", () => {
        seen.push(ctx.bus.emitPipe("agent:providers", { providers: [] }).providers.map(p => p.id));
      });
      ctx.agent!.providers.register({ id: "p", models: ["second"] });
      assert.deepEqual(seen, [["p"]]);
    },
  }] });
  await host.dispose();
});

test("sequential read-write-read executes all calls through policy with fresh results", async () => {
  let value = "old";
  let checks = 0;
  const scripted = { model: "test", async stream(opts: StreamOpts) {
    return (async function* () {
      const calls = opts.messages.some(m => m.role === "tool") ? undefined : ["read", "write", "read"].map((name, index) => ({
        index, id: `c${index}`, function: { name, arguments: "{}" },
      }));
      yield { choices: [{ delta: calls ? { tool_calls: calls } : { content: "done" } }] };
    })();
  } } as unknown as LlmClient;
  const host = await createAgentHost({ cwd: process.cwd(), extensions: [ashEngine({ client: scripted, tools: [
    { name: "read", description: "read", readOnly: true, input_schema: {}, execute: async () => ({ content: value, exitCode: 0, isError: false }) },
    { name: "write", description: "write", modifiesFiles: true, input_schema: {}, execute: async () => { value = "new"; return { content: "written", exitCode: 0, isError: false }; } },
  ] }), { name: "policy", activate(ctx) { ctx.advise("tool:execute", (next, input) => { checks++; return next(input); }); } }] });
  try {
    const result = await host.run("read write read", { toolScheduling: "sequential" });
    assert.equal(checks, 3);
    assert.deepEqual(result.details!.messages.filter(m => m.role === "tool").map(m => m.content), ["old", "written", "new"]);
  } finally { await host.dispose(); }
});

for (const toolsFirst of [true, false]) {
  test(`local read cache stays shared across snapshot restore, toolsFirst=${toolsFirst}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-cache-"));
    writeFileSync(join(dir, "example.txt"), "important file content");
    const engine = ashEngine({ client: client().fake });
    const tools = localTools({ names: ["read_file"] });
    const host = await createAgentHost({ cwd: dir, extensions: toolsFirst ? [tools, engine] : [engine, tools] });
    try {
      const snapshot = await host.snapshot();
      const read = () => host.context.call("tool:execute", {
        name: "read_file", id: "read", args: { path: "example.txt" },
        tool: host.context.agent!.getTools()[0], signal: new AbortController().signal,
      });
      assert.match((await read()).content, /important file content/);
      await host.restore(snapshot);
      assert.match((await read()).content, /important file content/);
    } finally { await host.dispose(); rmSync(dir, { recursive: true, force: true }); }
  });
}
