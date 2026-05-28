import test from "node:test";
import assert from "node:assert/strict";
import { UserShellIntents } from "../src/user-shell-intents.js";

test("consume with no pending intent returns null — the phantom-OSC case", () => {
  const intents = new UserShellIntents();
  assert.equal(intents.consume(), null);
});

test("push then consume returns the pushed intent", () => {
  const intents = new UserShellIntents();
  intents.push({ private: false });
  assert.deepEqual(intents.consume(), { private: false });
});

test("FIFO order is preserved across multiple pushes", () => {
  const intents = new UserShellIntents();
  intents.push({ private: false });
  intents.push({ private: true });
  intents.push({ private: false });
  assert.deepEqual(intents.consume(), { private: false });
  assert.deepEqual(intents.consume(), { private: true });
  assert.deepEqual(intents.consume(), { private: false });
});

test("a single push only matches one command-start; the next is treated as phantom", () => {
  const intents = new UserShellIntents();
  intents.push({ private: false });
  assert.notEqual(intents.consume(), null);
  assert.equal(intents.consume(), null);
});
