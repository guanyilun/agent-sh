import test from "node:test";
import assert from "node:assert/strict";
import { LiveView } from "../../src/agent/live-view.js";

// Guards the LiveView.link crash: link() indexes get(), forLLM() may be longer.

function withDanglingCall(): LiveView {
  const lv = new LiveView();
  lv.addUserMessage("run ffmpeg on the file");
  lv.addAssistantMessage("Let me inspect it first.", [
    { id: "call_1", function: { name: "execute", arguments: "{}" } },
  ]);
  return lv;
}

test("forLLM diverges from get() while a tool call is in flight", () => {
  const lv = withDanglingCall();
  assert.equal(lv.get().length, 2);
  assert.equal(lv.forLLM().length, 3);
});

test("link() targets canonical indices, not projection indices", () => {
  const lv = withDanglingCall();

  lv.link(lv.get().length - 1, "entry-assistant");
  assert.equal((lv.get()[1] as { meta?: { entryId?: string } }).meta?.entryId, "entry-assistant");

  assert.throws(() => lv.link(lv.forLLM().length - 1, "entry-oob"), /no message at index/);
});

const screenshot = { mimeType: "image/png", data: "A".repeat(250_000) };

test("images estimate as a flat IMAGE_TOKENS, not by base64 length", async () => {
  const { IMAGE_TOKENS } = await import("../../src/utils/token-estimate.js");
  const lv = new LiveView();
  lv.addUserMessage("look");
  const base = lv.estimateTokens();
  lv.addAssistantMessage("", [{ id: "c1", function: { name: "screenshot", arguments: "{}" } }]);
  lv.addToolResult("c1", [screenshot]);
  const added = lv.estimateTokens() - base;
  assert.ok(added >= IMAGE_TOKENS && added < IMAGE_TOKENS + 200, `image added ${added} tokens`);
});

test("trailing messages after the API anchor use the same image-aware estimate", () => {
  const lv = new LiveView();
  lv.addUserMessage("look");
  lv.updateApiTokenCount(10_000);
  lv.addAssistantMessage("", [{ id: "c1", function: { name: "screenshot", arguments: "{}" } }]);
  lv.addToolResult("c1", [screenshot]);
  assert.ok(lv.estimatePromptTokens() < 12_000, `got ${lv.estimatePromptTokens()}`);
});

test("estimate after replaceMessages keeps the system/tools overhead", () => {
  const lv = new LiveView();
  for (let i = 0; i < 20; i++) lv.addUserMessage("x".repeat(4000));
  lv.updateApiTokenCount(lv.estimateTokens() + 5_000);
  const before = lv.estimatePromptTokens();
  lv.replaceMessages(lv.get().slice(-2));
  const after = lv.estimatePromptTokens();
  assert.equal(after, 5_000 + lv.estimateTokens());
  assert.ok(after < before);
});
