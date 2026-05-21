import { register } from "node:module";
import { pathToFileURL } from "node:url";
import * as path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { createCore } from "../../src/core/index.js";
import activateAgentBackend from "../../src/extensions/agent-backend/index.js";
import type { AppConfig } from "../../src/shell/host-types.js";

register(new URL("../fixtures/pi-sdk-mock-loader.mjs", import.meta.url));

const stubModule = await import(
  new URL("../fixtures/pi-sdk-stub.mjs", import.meta.url).href
) as {
  __reset(): void;
  __emit(event: unknown): void;
  __promptCalls(): string[];
  __abortCalls(): number[];
};

const BRIDGE_URL = pathToFileURL(path.resolve("examples/extensions/pi-bridge/index.ts")).href;

interface LoadedBridge {
  core: ReturnType<typeof createCore>;
  bus: ReturnType<typeof createCore>["bus"];
}

async function loadBridge(): Promise<LoadedBridge> {
  stubModule.__reset();
  const core = createCore({} as AppConfig);
  const ctx = core.extensionContext({ quit: () => {} });
  activateAgentBackend(ctx);
  const mod = await import(`${BRIDGE_URL}?t=${Date.now()}`);
  const activate = (mod.default ?? mod.activate) as (c: typeof ctx) => void;
  activate(ctx);
  await core.activateBackend("pi");
  return { core, bus: core.bus };
}

function collect<T>(bus: LoadedBridge["bus"], event: string): T[] {
  const buf: T[] = [];
  bus.on(event as any, (e: T) => buf.push(e));
  return buf;
}

test("pi-bridge registers backend 'pi' after activate", async () => {
  const { bus } = await loadBridge();
  const { names, active } = bus.emitPipe("config:get-backends", { names: [] as string[], active: null });
  assert.ok(names.includes("pi"), `expected backend "pi" in ${names.join(", ")}`);
  assert.equal(active, "pi");
});

test("pi-bridge contributes identity (with model) via agent:identity pipe after boot", async () => {
  const { bus } = await loadBridge();
  const { identity } = bus.emitPipe("agent:identity", { identity: null });
  assert.ok(identity, "expected identity contributor installed");
  assert.equal(identity!.name, "pi");
  assert.equal(identity!.model, "stub/stub-model");
});

test("agent:submit forwards the query to session.prompt", async () => {
  const { bus } = await loadBridge();
  bus.emit("agent:submit", { query: "hello pi" });
  await new Promise((r) => setImmediate(r));
  const calls = stubModule.__promptCalls();
  assert.equal(calls.length, 1);
  assert.equal(calls[0], "hello pi");
});

test("text_delta events flow to agent:response-chunk", async () => {
  const { bus } = await loadBridge();
  const chunks = collect<{ blocks: Array<{ type: string; text: string }> }>(bus, "agent:response-chunk");

  stubModule.__emit({ type: "agent_start" });
  stubModule.__emit({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "hello" },
  });
  stubModule.__emit({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: " world" },
  });

  const text = chunks.flatMap((c) => c.blocks.map((b) => b.text)).join("");
  assert.equal(text, "hello world");
});

test("thinking_delta events flow to agent:thinking-chunk", async () => {
  const { bus } = await loadBridge();
  const thinks = collect<{ text: string }>(bus, "agent:thinking-chunk");

  stubModule.__emit({ type: "agent_start" });
  stubModule.__emit({
    type: "message_update",
    assistantMessageEvent: { type: "thinking_delta", delta: "let me think" },
  });

  assert.deepEqual(thinks.map((t) => t.text), ["let me think"]);
});

test("tool_execution_start/end flow to agent:tool-started + agent:tool-completed", async () => {
  const { bus } = await loadBridge();
  const started = collect<{ title: string; toolCallId: string; kind: string }>(bus, "agent:tool-started");
  const completed = collect<{ toolCallId: string; exitCode: number; kind: string }>(bus, "agent:tool-completed");

  stubModule.__emit({
    type: "tool_execution_start",
    toolCallId: "call-1",
    toolName: "bash",
    args: { cmd: "ls" },
  });
  stubModule.__emit({
    type: "tool_execution_end",
    toolCallId: "call-1",
    toolName: "bash",
    isError: false,
    result: { ok: true },
  });

  assert.equal(started.length, 1);
  assert.equal(started[0]!.title, "bash");
  assert.equal(started[0]!.toolCallId, "call-1");
  assert.equal(started[0]!.kind, "execute");
  assert.equal(completed.length, 1);
  assert.equal(completed[0]!.toolCallId, "call-1");
  assert.equal(completed[0]!.exitCode, 0);
});

test("agent_end fires agent:response-done and agent:processing-done", async () => {
  const { bus } = await loadBridge();
  const dones = collect<{ response: string }>(bus, "agent:response-done");
  const procs = collect<unknown>(bus, "agent:processing-done");

  stubModule.__emit({ type: "agent_start" });
  stubModule.__emit({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "ok." },
  });
  stubModule.__emit({ type: "agent_end" });

  assert.equal(dones.length, 1);
  assert.equal(dones[0]!.response, "ok.");
  assert.equal(procs.length, 1);
});

test("agent:cancel-request triggers session.abort", async () => {
  const { bus } = await loadBridge();
  const before = stubModule.__abortCalls().length;
  bus.emit("agent:cancel-request" as any, {});
  await new Promise((r) => setImmediate(r));
  assert.equal(stubModule.__abortCalls().length, before + 1);
});
