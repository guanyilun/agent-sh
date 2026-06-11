import test from "node:test";
import assert from "node:assert/strict";
import { UserShellIntents } from "../src/user-shell-intents.js";

test("consume with no pending intent returns null — the phantom-OSC case", () => {
  const intents = new UserShellIntents();
  assert.equal(intents.consume(), null);
});

test("push then consume returns the pushed intent, command and all", () => {
  const intents = new UserShellIntents();
  intents.push({ private: false, command: "ls" });
  assert.deepEqual(intents.consume(), { private: false, command: "ls" });
});

test("FIFO order is preserved across multiple pushes", () => {
  const intents = new UserShellIntents();
  intents.push({ private: false, command: "cd /a" });
  intents.push({ private: true, command: "secret" });
  intents.push({ private: false, command: "ls" });
  assert.deepEqual(intents.consume(), { private: false, command: "cd /a" });
  assert.deepEqual(intents.consume(), { private: true, command: "secret" });
  assert.deepEqual(intents.consume(), { private: false, command: "ls" });
});

test("a single push only matches one command-start; the next is treated as phantom", () => {
  const intents = new UserShellIntents();
  intents.push({ private: false, command: "ls" });
  assert.notEqual(intents.consume(), null);
  assert.equal(intents.consume(), null);
});
