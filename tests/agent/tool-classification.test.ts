import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createCore } from "../../src/core/index.js";
import { HandlerRegistry } from "../../src/utils/handler-registry.js";
import { attachAgentSurface } from "../../src/agent/surface.js";
import { bindLlmClient } from "../../src/agent/llm-binding.js";
import { LlmClient, type AgentShMessage, type CompleteOpts } from "../../src/agent/llm-client.js";
import { ToolRegistry } from "../../src/agent/tool-registry.js";
import type { ToolDefinition } from "../../src/agent/types.js";
import {
  isReadOnly, isReadOnlyToolEntry, registerReadOnlyTool, unregisterReadOnlyTool,
  type NuclearEntry, type ReadOnlyToolClassifier,
} from "../../src/agent/nuclear-form.js";
import { LiveView } from "../../src/agent/live-view.js";
import { InMemoryStore } from "../../src/agent/store.js";
import {
  inferPriority, slimTurn, Priority, makeCompactAdvisor, type SummaryCtx,
} from "../../src/agent/extensions/rolling-history/strategy.js";
import { migrateFromLegacy } from "../../src/agent/extensions/rolling-history/index.js";

function tool(name: string, readOnly?: boolean): ToolDefinition {
  return {
    name, readOnly, description: name, input_schema: { type: "object" },
    execute: async () => ({ content: "ok", exitCode: 0, isError: false }),
  };
}

function entry(name: string, kind = "tool"): NuclearEntry {
  return { seq: 1, ts: 0, iid: "test", kind, tool: name, sum: name };
}

function toolMessages(name: string): AgentShMessage[] {
  return [
    { role: "assistant", content: null, tool_calls: [
      { id: "call", type: "function", function: { name, arguments: "{}" } },
    ] },
    { role: "tool", tool_call_id: "call", content: "ok", meta: { tool: { toolName: name, args: {} } } },
  ];
}

function host(readOnly: boolean) {
  const core = createCore({});
  const ctx = core.extensionContext({ quit: () => {} });
  const surface = attachAgentSurface(ctx);
  surface.registerTool(tool("shared_tool", readOnly));
  const classifier: ReadOnlyToolClassifier = (name) => ctx.call("agent:is-read-only-tool", name);
  return { ctx, surface, classifier };
}

test("shared LLM binding preserves legacy option translation and client identity", async () => {
  const handlers = new HandlerRegistry();
  const client = new LlmClient({ apiKey: "test", model: "default" });
  const calls: CompleteOpts[] = [];
  client.complete = async (opts) => { calls.push(opts); return "answer"; };
  bindLlmClient(handlers, client);
  assert.equal(handlers.call("llm:get-client"), client);
  const messages: AgentShMessage[] = [{ role: "user", content: "hello" }];
  assert.equal(await handlers.call("llm:invoke", messages, {
    maxTokens: 23, model: "override", reasoningEffort: "xhigh",
  }), "answer");
  assert.deepEqual(calls[0], { messages, max_tokens: 23, model: "override", reasoning_effort: "high" });
  for (const effort of [undefined, "off", "", "low", "medium", "high"]) {
    await handlers.call("llm:invoke", messages, effort === undefined ? undefined : { reasoningEffort: effort });
    const call = calls.at(-1)!;
    assert.equal(call.max_tokens, undefined);
    assert.equal(call.model, undefined);
    assert.equal(call.reasoning_effort, effort && effort !== "off" ? effort : undefined);
    assert.equal("reasoning_effort" in call, !!effort && effort !== "off");
    assert.ok(!("maxTokens" in call) && !("reasoningEffort" in call));
  }
  const other = new HandlerRegistry();
  const otherClient = client.fork();
  otherClient.complete = async () => "other";
  bindLlmClient(other, otherClient);
  assert.equal(await other.call("llm:invoke", messages), "other");
  assert.equal(await handlers.call("llm:invoke", messages), "answer");
});

test("ToolRegistry registration and removal do not mutate legacy global classification", () => {
  const name = "registry_local_tool";
  const a = new ToolRegistry(new HandlerRegistry());
  const b = new ToolRegistry(new HandlerRegistry());
  try {
    a.register(tool(name, true));
    b.register(tool(name, false));
    assert.equal(isReadOnly(entry(name)), false);
    assert.equal(a.get(name)?.readOnly, true);
    assert.equal(b.get(name)?.readOnly, false);
    registerReadOnlyTool(name);
    assert.equal(isReadOnly(entry(name)), true, "legacy opt-in remains available externally");
    b.unregister(name);
    b.register(tool(name, false));
    a.unregister(name);
    assert.equal(isReadOnly(entry(name)), true, "registry changes must not erase legacy opt-ins");
    assert.equal(isReadOnlyToolEntry(entry(name)), false, "runtime helper ignores legacy globals");
  } finally {
    unregisterReadOnlyTool(name);
  }
});

test("instance classification permits explicit false, built-in fallback, and preserves errors", () => {
  const unknown: ReadOnlyToolClassifier = () => undefined;
  assert.equal(isReadOnlyToolEntry(entry("read_file")), true);
  assert.equal(isReadOnlyToolEntry(entry("read_file"), unknown), true);
  assert.equal(isReadOnlyToolEntry(entry("read_file"), () => false), false);
  assert.equal(isReadOnly(entry("read_file"), () => false), false);
  for (const kind of ["error", "user", "agent", "session"]) {
    assert.equal(isReadOnlyToolEntry(entry("read_file", kind), () => true), false);
  }
  assert.equal(isReadOnlyToolEntry({ ...entry("read_file"), tool: undefined }), false);
  assert.equal(isReadOnlyToolEntry(entry("unknown"), unknown), false);
});

test("two hosts classify the same tool independently through unregister and legacy opt-ins", () => {
  const a = host(true);
  const b = host(false);
  const ne = entry("shared_tool");
  try {
    registerReadOnlyTool("shared_tool");
    assert.equal(isReadOnlyToolEntry(ne, a.classifier), true);
    assert.equal(isReadOnlyToolEntry(ne, b.classifier), false);
    const msgs = toolMessages("shared_tool");
    assert.equal(inferPriority(msgs, a.classifier), Priority.LOWEST);
    assert.equal(inferPriority(msgs, b.classifier), Priority.LOW);
    assert.equal(slimTurn(msgs, a.classifier).length, 0);
    assert.deepEqual(slimTurn(msgs, b.classifier), msgs);
    a.surface.unregisterTool("shared_tool");
    a.surface.registerTool(tool("shared_tool", false));
    assert.equal(isReadOnlyToolEntry(ne, a.classifier), false);
    assert.equal(isReadOnlyToolEntry(ne, b.classifier), false);
    b.surface.unregisterTool("shared_tool");
    b.surface.registerTool(tool("shared_tool", true));
    assert.equal(isReadOnlyToolEntry(ne, a.classifier), false);
    assert.equal(isReadOnlyToolEntry(ne, b.classifier), true);
  } finally {
    unregisterReadOnlyTool("shared_tool");
  }
});

test("rolling-history defaults ignore global opt-ins without changing write/error/orphan priority", () => {
  registerReadOnlyTool("shared_tool");
  try {
    const msgs = toolMessages("shared_tool");
    assert.equal(inferPriority(msgs), Priority.LOW);
    assert.deepEqual(slimTurn(msgs), msgs);
    assert.equal(inferPriority(toolMessages("write_file"), () => true), Priority.MEDIUM);
    const errors = toolMessages("shared_tool");
    errors[1]!.content = "Error: failed";
    assert.equal(inferPriority(errors, () => true), Priority.HIGH);
    assert.equal(inferPriority([msgs[1]!]), Priority.LOWEST, "existing orphan-result semantics are unchanged");
    assert.equal(slimTurn(toolMessages("read_file"), () => undefined).length, 0);
    assert.equal(slimTurn(toolMessages("read_file"), () => false).length, 2);
  } finally {
    unregisterReadOnlyTool("shared_tool");
  }
});

test("rolling-history compaction uses per-host metadata for summary filtering", async () => {
  for (const readOnly of [true, false]) {
    const { classifier } = host(readOnly);
    const view = new LiveView(null, "test");
    const messages: AgentShMessage[] = [];
    for (let i = 0; i < 8; i++) {
      messages.push({ role: "user", content: `turn ${i}` }, ...toolMessages("shared_tool"));
    }
    view.replaceMessages(messages);
    const store = new InMemoryStore();
    const ctx: SummaryCtx = {
      store, bus: { on: () => {} }, advise: () => {}, iid: "test", isReadOnlyTool: classifier,
      getMessages: () => view.get(), replaceMessages: (msgs) => view.replace(msgs),
      estimateTokens: () => view.estimateTokens(), estimatePromptTokens: () => view.estimatePromptTokens(),
      linkMessage: (i, id) => view.link(i, id),
    };
    const result = await makeCompactAdvisor(ctx)(async () => null, { target: 0, force: true });
    assert.ok(result && result.evictedCount > 0);
    const summaries = (await store.readRecent()).filter((e) => e.kind === "tool");
    assert.equal(summaries.length > 0, !readOnly);
  }
});

test("legacy history migration uses each host's classifier, not process globals", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tool-classification-"));
  try {
    const legacy = path.join(dir, "legacy");
    fs.writeFileSync(legacy, [entry("shared_tool"), entry("shared_tool", "error")].map((ne) => JSON.stringify(ne)).join("\n"));
    registerReadOnlyTool("shared_tool");
    for (const readOnly of [true, false]) {
      const { ctx } = host(readOnly);
      const storeDir = path.join(dir, String(readOnly));
      fs.mkdirSync(storeDir);
      migrateFromLegacy(storeDir, legacy, ctx);
      const migrated = fs.readFileSync(path.join(storeDir, "history.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
      assert.equal(migrated.length, readOnly ? 1 : 2);
      assert.equal(migrated.at(-1).kind, "error");
    }
  } finally {
    unregisterReadOnlyTool("shared_tool");
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
