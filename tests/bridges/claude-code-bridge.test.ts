import { register } from "node:module";
import { pathToFileURL } from "node:url";
import * as path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { createCore } from "../../src/core/index.js";
import activateAgentBackend from "../../src/extensions/agent-backend/index.js";
import type { AppConfig } from "../../src/shell/host-types.js";

register(new URL("../fixtures/claude-sdk-mock-loader.mjs", import.meta.url));

const stubModule = await import(
  new URL("../fixtures/claude-sdk-stub.mjs", import.meta.url).href
) as {
  __reset(): void;
  __queryCalls(): Array<{ prompt: string; options: Record<string, unknown> }>;
  __pushMessage(msg: unknown): void;
  __endQuery(): void;
  __wasInterrupted(): boolean;
};

const BRIDGE_URL = pathToFileURL(path.resolve("examples/extensions/claude-code-bridge/index.ts")).href;

interface LoadedBridge {
  core: ReturnType<typeof createCore>;
  bus: ReturnType<typeof createCore>["bus"];
}

const microtask = () => new Promise<void>((r) => setImmediate(r));
async function flush(n = 8): Promise<void> {
  for (let i = 0; i < n; i++) await microtask();
}

async function loadBridge(): Promise<LoadedBridge> {
  stubModule.__reset();
  const core = createCore({} as AppConfig);
  const ctx = core.extensionContext({ quit: () => {} });
  activateAgentBackend(ctx);
  const mod = await import(`${BRIDGE_URL}?t=${Date.now()}`);
  const activate = (mod.default ?? mod.activate) as (c: typeof ctx) => void;
  activate(ctx);
  await core.activateBackend("claude-code");
  return { core, bus: core.bus };
}

function collect<T>(bus: LoadedBridge["bus"], event: string): T[] {
  const buf: T[] = [];
  bus.on(event as any, (e: T) => buf.push(e));
  return buf;
}

test("claude-code-bridge registers backend 'claude-code' after activate", async () => {
  const { bus } = await loadBridge();
  const { names, active } = bus.emitPipe("config:get-backends", { names: [] as string[], active: null });
  assert.ok(names.includes("claude-code"), `expected backend "claude-code" in ${names.join(", ")}`);
  assert.equal(active, "claude-code");
});

test("claude-code-bridge contributes identity via agent:identity pipe after boot", async () => {
  const { bus } = await loadBridge();
  const { identity } = bus.emitPipe("agent:identity", { identity: null });
  assert.ok(identity, "expected identity contributor installed");
  assert.equal(identity!.name, "claude-code");
  assert.equal(identity!.version, "1.0");
});

test("agent:submit calls query() with the user prompt and standard options", async () => {
  const { bus } = await loadBridge();
  bus.emit("agent:submit", { query: "do the thing" });
  await flush();

  const calls = stubModule.__queryCalls();
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.prompt, "do the thing");
  const opts = calls[0]!.options as { allowedTools: string[]; permissionMode: string; includePartialMessages: boolean };
  assert.deepEqual(opts.allowedTools, ["Read", "Edit", "Write", "Bash", "Glob", "Grep"]);
  assert.equal(opts.permissionMode, "acceptEdits");
  assert.equal(opts.includePartialMessages, true);
});

test("text_delta stream events flow to agent:response-chunk", async () => {
  const { bus } = await loadBridge();
  const chunks = collect<{ blocks: Array<{ type: string; text: string }> }>(bus, "agent:response-chunk");

  bus.emit("agent:submit", { query: "hello" });
  await flush();

  stubModule.__pushMessage({
    type: "stream_event",
    event: {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "hello" },
    },
  });
  stubModule.__pushMessage({
    type: "stream_event",
    event: {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: " world" },
    },
  });
  stubModule.__endQuery();
  await flush();

  const text = chunks.flatMap((c) => c.blocks.map((b) => b.text)).join("");
  assert.equal(text, "hello world");
});

test("thinking_delta stream events flow to agent:thinking-chunk", async () => {
  const { bus } = await loadBridge();
  const thinks = collect<{ text: string }>(bus, "agent:thinking-chunk");

  bus.emit("agent:submit", { query: "ponder" });
  await flush();

  stubModule.__pushMessage({
    type: "stream_event",
    event: {
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "considering" },
    },
  });
  stubModule.__endQuery();
  await flush();

  assert.deepEqual(thinks.map((t) => t.text), ["considering"]);
});

test("tool_use streamed via content_block_* events flows to agent:tool-started", async () => {
  const { bus } = await loadBridge();
  const started = collect<{ title: string; toolCallId: string; kind: string }>(bus, "agent:tool-started");

  bus.emit("agent:submit", { query: "list files" });
  await flush();

  stubModule.__pushMessage({
    type: "stream_event",
    event: {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "tool-1", name: "Bash" },
    },
  });
  stubModule.__pushMessage({
    type: "stream_event",
    event: {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: "{\"command\":\"ls\"}" },
    },
  });
  stubModule.__pushMessage({
    type: "stream_event",
    event: { type: "content_block_stop", index: 0 },
  });
  stubModule.__endQuery();
  await flush();

  assert.equal(started.length, 1);
  assert.equal(started[0]!.title, "Bash");
  assert.equal(started[0]!.toolCallId, "tool-1");
  assert.equal(started[0]!.kind, "execute");
});

test("tool_result user message flows to agent:tool-completed", async () => {
  const { bus } = await loadBridge();
  const completed = collect<{ toolCallId: string; exitCode: number }>(bus, "agent:tool-completed");

  bus.emit("agent:submit", { query: "run ls" });
  await flush();

  stubModule.__pushMessage({
    type: "stream_event",
    event: {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "tool-1", name: "Bash" },
    },
  });
  stubModule.__pushMessage({
    type: "stream_event",
    event: {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: "{\"command\":\"ls\"}" },
    },
  });
  stubModule.__pushMessage({
    type: "stream_event",
    event: { type: "content_block_stop", index: 0 },
  });
  stubModule.__pushMessage({
    type: "user",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: "tool-1",
          is_error: false,
          content: "file1.txt\nfile2.txt\n",
        },
      ],
    },
  });
  stubModule.__endQuery();
  await flush();

  assert.equal(completed.length, 1);
  assert.equal(completed[0]!.toolCallId, "tool-1");
  assert.equal(completed[0]!.exitCode, 0);
});

test("agent:cancel-request calls .interrupt() on the active query", async () => {
  const { bus } = await loadBridge();
  bus.emit("agent:submit", { query: "long task" });
  await flush();
  assert.equal(stubModule.__wasInterrupted(), false);

  bus.emit("agent:cancel-request" as any, {});
  await flush();

  assert.equal(stubModule.__wasInterrupted(), true);
});

test("iterator end fires agent:response-done with accumulated text", async () => {
  const { bus } = await loadBridge();
  const dones = collect<{ response: string }>(bus, "agent:response-done");
  const procDones = collect<unknown>(bus, "agent:processing-done");

  bus.emit("agent:submit", { query: "say hi" });
  await flush();

  stubModule.__pushMessage({
    type: "stream_event",
    event: {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "hi there" },
    },
  });
  stubModule.__endQuery();
  await flush();

  assert.equal(dones.length, 1);
  assert.equal(dones[0]!.response, "hi there");
  assert.equal(procDones.length, 1);
});
