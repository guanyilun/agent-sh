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
