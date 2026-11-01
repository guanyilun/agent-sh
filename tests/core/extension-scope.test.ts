import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../../src/core/event-bus.js";
import { HandlerRegistry } from "../../src/utils/handler-registry.js";
import type { ExtensionContext } from "../../src/shell/host-types.js";
import type { AgentSurface } from "../../src/agent/host-types.js";

const TEST_HOME = await mkdtemp(join(tmpdir(), "extension-scope-home-"));
process.env.AGENT_SH_HOME = TEST_HOME;
const { createScopedContext, loadExtensions } = await import("../../src/core/extension-loader.js");
after(() => rm(TEST_HOME, { recursive: true, force: true }));

function host() {
  const handlers = new HandlerRegistry();
  const bus = new EventBus();
  const ctx: ExtensionContext = {
    bus, instanceId: "test", quit() {},
    getExtensionSettings: (_namespace, defaults) => defaults,
    getStoragePath: () => tmpdir(),
    define: (name, fn) => handlers.define(name, fn),
    advise: (name, fn) => handlers.advise(name, fn),
    call: (name, ...args) => handlers.call(name, ...args),
    list: () => handlers.list(),
    onDispose() {}, registerCommand() {}, adviseCommand: () => () => {},
  };
  return { ctx, bus, handlers };
}

function agentSurface() {
  const tools = new Map<string, any>();
  const instructions = new Map<string, string>();
  const skills = new Map<string, string>();
  const providers = new Map<string, object>();
  let providerDisposals = 0;
  let producerDisposals = 0;
  const agent: AgentSurface = {
    llm: { available: false } as AgentSurface["llm"],
    providers: {
      register(reg) {
        const token = {};
        providers.set(reg.id, token);
        return () => {
          providerDisposals++;
          if (providers.get(reg.id) === token) providers.delete(reg.id);
        };
      },
      unregister(id) { providers.delete(id); }, configure() {},
    },
    registerTool(tool) { tools.set(tool.name, tool); },
    unregisterTool(name) { tools.delete(name); }, getTools: () => [...tools.values()],
    registerInstruction(name, text) { instructions.set(name, text); },
    removeInstruction(name) { instructions.delete(name); },
    registerSkill(name, _description, filePath) { skills.set(name, filePath); },
    removeSkill(name) { skills.delete(name); },
    adviseTool: () => () => {}, adviseToolSchema: () => () => {},
    adviseInstruction: () => () => {}, adviseSkill: () => () => {},
    registerContextProducer: () => () => { producerDisposals++; },
  };
  return { agent, tools, instructions, skills, providers,
    counts: () => ({ providerDisposals, producerDisposals }) };
}

const tool = (name: string) => ({ name, description: "test", input_schema: {},
  execute: async () => ({ content: "", exitCode: 0, isError: false }) });

test("scope disposes event listeners, sync/async pipes, wildcard and advice once", async () => {
  const { ctx, bus, handlers } = host();
  handlers.define("value", () => "base");
  const { scoped, dispose } = createScopedContext(ctx, "events");
  let events = 0;
  let wildcard = 0;
  let cleanup = 0;
  scoped.bus.on("ui:info", () => events++);
  scoped.bus.onAny(() => wildcard++);
  scoped.bus.onPipe("ui:info", p => ({ message: p.message + "!" }));
  scoped.bus.onPipeAsync("ui:info", async p => ({ message: p.message + "?" }));
  scoped.advise("value", next => next() + " advised");
  scoped.onDispose(() => { cleanup++; dispose(); throw new Error("cleanup fault"); });
  scoped.onDispose(() => { cleanup++; });
  bus.emit("ui:info", { message: "hello" });
  assert.equal(events, 1);
  assert.equal(wildcard, 1);
  assert.equal(bus.emitPipe("ui:info", { message: "a" }).message, "a!");
  assert.equal((await bus.emitPipeAsync("ui:info", { message: "a" })).message, "a?");
  assert.equal(ctx.call("value"), "base advised");
  dispose(); dispose();
  bus.emit("ui:info", { message: "hello" });
  assert.equal(events, 2);
  assert.equal(wildcard, 2);
  assert.equal(cleanup, 2);
  assert.equal(bus.emitPipe("ui:info", { message: "a" }).message, "a");
  assert.equal((await bus.emitPipeAsync("ui:info", { message: "a" })).message, "a");
  assert.equal(ctx.call("value"), "base");
});

test("manual unsubscription and provider disposers are idempotent", () => {
  const { ctx } = host();
  const surface = agentSurface();
  ctx.agent = surface.agent;
  const { scoped, dispose } = createScopedContext(ctx, "providers");
  const unsubscribe = scoped.agent!.providers.register({ id: "p" });
  const producer = scoped.agent!.registerContextProducer("p", () => "context");
  unsubscribe(); unsubscribe(); producer(); producer();
  dispose(); dispose();
  assert.deepEqual(surface.counts(), { providerDisposals: 1, producerDisposals: 1 });
});

test("provider unregister and subsequent replacement do not transfer old ownership", () => {
  const { ctx } = host();
  const surface = agentSurface();
  ctx.agent = surface.agent;
  const scope = createScopedContext(ctx, "providers");
  scope.scoped.agent!.providers.register({ id: "p" });
  scope.scoped.agent!.providers.unregister("p");
  assert.equal(surface.providers.size, 0);
  surface.agent.providers.register({ id: "p" });
  scope.dispose();
  assert.equal(surface.providers.size, 1);
  assert.equal(surface.counts().providerDisposals, 1, "unregister consumes the tracked disposer");
  scope.scoped.agent!.providers.unregister("p");
  assert.equal(surface.providers.size, 1, "a closed scope cannot remove a replacement");
});

test("old provider scope cannot unregister a raw replacement", () => {
  const { ctx } = host();
  const surface = agentSurface();
  ctx.agent = surface.agent;
  const first = createScopedContext(ctx, "first");
  first.scoped.agent!.providers.register({ id: "p" });
  surface.agent.providers.register({ id: "p" });
  first.dispose();
  assert.equal(surface.providers.size, 1);
});

test("scoped tool, skill and instruction replacements are not removed or resurrected", () => {
  const { ctx } = host();
  const surface = agentSurface();
  ctx.agent = surface.agent;
  const first = createScopedContext(ctx, "same-name");
  const second = createScopedContext(ctx, "same-name");
  for (const [scope, value] of [[first, "first"], [second, "second"]] as const) {
    scope.scoped.agent!.registerTool(tool("t"));
    scope.scoped.agent!.registerInstruction("i", value);
    scope.scoped.agent!.registerSkill("s", "skill", value);
  }
  first.dispose();
  assert.equal(surface.tools.size, 1);
  assert.equal(surface.instructions.get("i"), "second");
  assert.equal(surface.skills.get("s"), "second");
  second.dispose();
  assert.equal(surface.tools.size + surface.instructions.size + surface.skills.size, 0);
});

test("explicit unregister invalidates earlier ownership before replacement", () => {
  const { ctx } = host();
  const surface = agentSurface();
  ctx.agent = surface.agent;
  const first = createScopedContext(ctx, "first");
  const second = createScopedContext(ctx, "second");
  first.scoped.agent!.registerTool(tool("t"));
  second.scoped.agent!.unregisterTool("t");
  second.scoped.agent!.registerTool(tool("t"));
  first.dispose();
  assert.equal(surface.tools.size, 1);
  second.dispose();
  assert.equal(surface.tools.size, 0);
});

test("define restores the previous base while preserving independent advice", () => {
  const { ctx, handlers } = host();
  handlers.define("value", () => "original");
  const first = createScopedContext(ctx, "first");
  first.scoped.define("value", () => "owned");
  const unadvise = handlers.advise("value", next => `[${next()}]`);
  assert.equal(ctx.call("value"), "[owned]");
  first.dispose();
  assert.equal(ctx.call("value"), "[original]");
  unadvise();
  assert.equal(ctx.call("value"), "original");
});

test("out-of-order definition disposal cannot restore a dead base", () => {
  const { ctx } = host();
  const first = createScopedContext(ctx, "first");
  const second = createScopedContext(ctx, "second");
  first.scoped.define("value", () => "first");
  second.scoped.define("value", () => "second");
  first.dispose();
  assert.equal(ctx.call("value"), "second");
  second.dispose();
  assert.equal(ctx.call("value"), undefined);
  assert.ok(!ctx.list().includes("value"));
});

test("raw handler replacement survives scope disposal, and advice-only entries survive", () => {
  const { ctx, handlers } = host();
  const scope = createScopedContext(ctx, "scope");
  scope.scoped.define("raw", () => "scoped");
  const release = handlers.define("raw", () => "raw");
  const unadvise = handlers.advise("advice-only", next => next() ?? "fallback");
  scope.scoped.define("advice-only", () => "owned");
  scope.dispose();
  assert.equal(ctx.call("raw"), "raw");
  assert.equal(ctx.call("advice-only"), "fallback");
  release(); unadvise();
  assert.deepEqual(ctx.list(), []);
});

test("late and reentrant registrations cannot leak after disposal", async () => {
  const { ctx, bus } = host();
  const surface = agentSurface();
  ctx.agent = surface.agent;
  const { scoped, dispose } = createScopedContext(ctx, "late");
  let calls = 0;
  const register = () => {
    scoped.bus.on("ui:info", () => calls++);
    scoped.bus.onPipe("ui:info", p => ({ message: p.message + "!" }));
    scoped.bus.onPipeAsync("ui:info", async p => ({ message: p.message + "?" }));
    scoped.bus.onAny(() => calls++);
    scoped.define("late", () => true);
    scoped.agent!.registerTool(tool("late"));
    scoped.agent!.registerSkill("late", "late", "late");
    scoped.agent!.registerInstruction("late", "late");
    scoped.agent!.providers.register({ id: "late" });
    scoped.agent!.registerContextProducer("late", () => "late");
  };
  scoped.onDispose(register);
  scoped.onDispose(async () => { throw new Error("async fault"); });
  dispose();
  await Promise.resolve();
  register();
  scoped.onDispose(() => calls++);
  assert.equal(calls, 1, "late cleanup runs immediately");
  bus.emit("ui:info", { message: "hello" });
  assert.equal(calls, 1);
  assert.equal((await bus.emitPipeAsync("ui:info", { message: "a" })).message, "a");
  assert.deepEqual(ctx.list(), []);
  assert.equal(surface.tools.size + surface.skills.size + surface.instructions.size + surface.providers.size, 0);
  assert.deepEqual(surface.counts(), { providerDisposals: 0, producerDisposals: 0 });
});

test("surfaces attached after scope creation stay raw on the host and are scoped on access", () => {
  const { ctx } = host();
  const first = createScopedContext(ctx, "first");
  const second = createScopedContext(ctx, "second");
  assert.equal(first.scoped.agent, undefined);
  const surface = agentSurface();
  first.scoped.agent = surface.agent;
  assert.equal(ctx.agent, surface.agent);
  assert.notEqual(first.scoped.agent, surface.agent);
  assert.equal(first.scoped.agent, first.scoped.agent);
  first.scoped.agent!.registerSkill("a", "a", "a");
  second.scoped.agent!.registerSkill("b", "b", "b");
  first.dispose();
  assert.deepEqual([...surface.skills.keys()], ["b"]);
  second.dispose();
  assert.equal(surface.skills.size, 0);
});

test("command replacement and manual advice disposal preserve other scope ownership", () => {
  const { ctx, bus } = host();
  const commands = new Set<string>();
  let unadvised = 0;
  ctx.registerCommand = name => { commands.add(name.replace(/^\//, "")); };
  ctx.adviseCommand = () => () => { unadvised++; };
  bus.on("command:unregister", ({ name }) => commands.delete(name.replace(/^\//, "")));
  const first = createScopedContext(ctx, "first");
  const second = createScopedContext(ctx, "second");
  first.scoped.registerCommand("/test", "test", () => {});
  second.scoped.registerCommand("test", "replacement", () => {});
  const release = first.scoped.adviseCommand("test", next => next(""));
  release(); first.dispose();
  assert.equal(unadvised, 1);
  assert.ok(commands.has("test"));
  second.dispose();
  assert.equal(commands.size, 0);
});

test("failed activation cleans partial registrations; identical loader names are host-local", async () => {
  const dir = await mkdtemp(join(tmpdir(), "extension-scope-"));
  try {
    const good = join(dir, "owned.mjs");
    const bad = join(dir, "failed.mjs");
    await writeFile(good, 'export default ctx => { ctx.define("loader:owned", () => true); };');
    await writeFile(bad, 'export default async ctx => { ctx.define("loader:failed", () => true); throw Error("activation failed"); };');
    const first = host();
    const second = host();
    await loadExtensions(first.ctx, [good, bad]);
    assert.equal(first.ctx.call("loader:owned"), true);
    assert.equal(first.ctx.call("loader:failed"), undefined);
    await loadExtensions(second.ctx, [good]);
    assert.equal(first.ctx.call("loader:owned"), true);
    assert.equal(second.ctx.call("loader:owned"), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
