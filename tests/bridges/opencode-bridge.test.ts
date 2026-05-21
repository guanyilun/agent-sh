import { register } from "node:module";
import { pathToFileURL } from "node:url";
import * as path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { createCore } from "../../src/core/index.js";
import activateAgentBackend from "../../src/extensions/agent-backend/index.js";
import type { AppConfig } from "../../src/shell/host-types.js";

register(new URL("../fixtures/opencode-sdk-mock-loader.mjs", import.meta.url));

const stubModule = await import(
  new URL("../fixtures/opencode-sdk-stub.mjs", import.meta.url).href
) as {
  __reset(): void;
  __emitEvent(event: unknown): void;
  __sessionId(): string;
  __promptCalls(): Array<{ sessionID: string; directory: string; parts: unknown[] }>;
  __abortCalls(): Array<{ sessionID: string; directory: string }>;
  __permissionReplies(): Array<{ requestID: string; reply: string }>;
};

const BRIDGE_URL = pathToFileURL(path.resolve("examples/extensions/opencode-bridge/index.ts")).href;

interface LoadedBridge {
  core: ReturnType<typeof createCore>;
  bus: ReturnType<typeof createCore>["bus"];
}

async function loadBridge(): Promise<LoadedBridge> {
  stubModule.__reset();
  const core = createCore({} as AppConfig);
  const ctx = core.extensionContext({ quit: () => {} });
  (ctx as { shell?: unknown }).shell = {
    compositor: { surface: () => null },
  };
  activateAgentBackend(ctx);
  const mod = await import(`${BRIDGE_URL}?t=${Date.now()}`);
  const activate = (mod.default ?? mod.activate) as (c: typeof ctx) => void;
  activate(ctx);
  await core.activateBackend("opencode");
  // consumeEvents is void inside start(); flush so the for-await registers.
  await flush();
  return { core, bus: core.bus };
}

function collect<T>(bus: LoadedBridge["bus"], event: string): T[] {
  const buf: T[] = [];
  bus.on(event as any, (e: T) => buf.push(e));
  return buf;
}

const microtask = () => new Promise<void>((r) => setImmediate(r));

async function flush(n = 8): Promise<void> {
  for (let i = 0; i < n; i++) await microtask();
}

test("opencode-bridge registers backend 'opencode' after activate", async () => {
  const { bus } = await loadBridge();
  const { names, active } = bus.emitPipe("config:get-backends", { names: [] as string[], active: null });
  assert.ok(names.includes("opencode"), `expected backend "opencode" in ${names.join(", ")}`);
  assert.equal(active, "opencode");
});

test("opencode-bridge emits agent:info after boot", async () => {
  const infos: Array<{ name: string; version?: string }> = [];
  const core = createCore({} as AppConfig);
  core.bus.on("agent:info", (info) => { infos.push(info); });
  const ctx = core.extensionContext({ quit: () => {} });
  (ctx as { shell?: unknown }).shell = { compositor: { surface: () => null } };
  activateAgentBackend(ctx);
  stubModule.__reset();
  const mod = await import(`${BRIDGE_URL}?t=${Date.now()}`);
  (mod.default ?? mod.activate)(ctx);
  await core.activateBackend("opencode");

  assert.equal(infos.length, 1);
  assert.equal(infos[0]!.name, "opencode");
});

test("agent:submit forwards the query to client.session.prompt", async () => {
  const { bus } = await loadBridge();
  bus.emit("agent:submit", { query: "hello opencode" });
  await flush();

  const calls = stubModule.__promptCalls();
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.sessionID, stubModule.__sessionId());
  const parts = calls[0]!.parts as Array<{ type: string; text: string }>;
  assert.equal(parts.length, 1);
  assert.equal(parts[0]!.type, "text");
  assert.equal(parts[0]!.text, "hello opencode");
});

test("message.part.delta with text kind flows to agent:response-chunk", async () => {
  const { bus } = await loadBridge();
  const chunks = collect<{ blocks: Array<{ type: string; text: string }> }>(bus, "agent:response-chunk");

  stubModule.__emitEvent({
    type: "message.part.updated",
    properties: { part: { id: "p1", type: "text" } },
  });
  stubModule.__emitEvent({
    type: "message.part.delta",
    properties: { partID: "p1", delta: "hello" },
  });
  stubModule.__emitEvent({
    type: "message.part.delta",
    properties: { partID: "p1", delta: " world" },
  });
  await flush();

  const text = chunks.flatMap((c) => c.blocks.map((b) => b.text)).join("");
  assert.equal(text, "hello world");
});

test("message.part.delta with reasoning kind flows to agent:thinking-chunk", async () => {
  const { bus } = await loadBridge();
  const thinks = collect<{ text: string }>(bus, "agent:thinking-chunk");

  stubModule.__emitEvent({
    type: "message.part.updated",
    properties: { part: { id: "r1", type: "reasoning" } },
  });
  stubModule.__emitEvent({
    type: "message.part.delta",
    properties: { partID: "r1", delta: "let me think" },
  });
  await flush();

  assert.deepEqual(thinks.map((t) => t.text), ["let me think"]);
});

test("tool part updates flow to agent:tool-started + agent:tool-completed", async () => {
  const { bus } = await loadBridge();
  const started = collect<{ title: string; toolCallId: string; kind: string }>(bus, "agent:tool-started");
  const completed = collect<{ toolCallId: string; exitCode: number; kind: string }>(bus, "agent:tool-completed");

  stubModule.__emitEvent({
    type: "message.part.updated",
    properties: {
      part: {
        id: "t1",
        type: "tool",
        callID: "call-1",
        tool: "bash",
        state: { status: "running", input: { command: "ls" } },
      },
    },
  });
  stubModule.__emitEvent({
    type: "message.part.updated",
    properties: {
      part: {
        id: "t1",
        type: "tool",
        callID: "call-1",
        tool: "bash",
        state: { status: "completed", input: { command: "ls" }, output: "file.txt\n" },
      },
    },
  });
  await flush();

  assert.equal(started.length, 1);
  assert.equal(started[0]!.title, "bash");
  assert.equal(started[0]!.toolCallId, "call-1");
  assert.equal(started[0]!.kind, "execute");
  assert.equal(completed.length, 1);
  assert.equal(completed[0]!.toolCallId, "call-1");
  assert.equal(completed[0]!.exitCode, 0);
});

test("session.error flows to agent:error", async () => {
  const { bus } = await loadBridge();
  const errors = collect<{ message: string }>(bus, "agent:error");

  stubModule.__emitEvent({
    type: "session.error",
    properties: { error: { message: "boom" } },
  });
  await flush();

  assert.equal(errors.length, 1);
  assert.equal(errors[0]!.message, "boom");
});

test("agent:cancel-request triggers client.session.abort", async () => {
  const { bus } = await loadBridge();
  const before = stubModule.__abortCalls().length;
  bus.emit("agent:cancel-request" as any, {});
  await flush();
  const after = stubModule.__abortCalls();
  assert.equal(after.length, before + 1);
  assert.equal(after[before]!.sessionID, stubModule.__sessionId());
});

test("permission.asked is auto-approved via client.permission.reply", async () => {
  const { bus: _ } = await loadBridge();
  stubModule.__emitEvent({
    type: "permission.asked",
    properties: { id: "req-42" },
  });
  await flush();

  const replies = stubModule.__permissionReplies();
  assert.equal(replies.length, 1);
  assert.equal(replies[0]!.requestID, "req-42");
  assert.equal(replies[0]!.reply, "once");
});
