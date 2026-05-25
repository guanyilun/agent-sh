import test from "node:test";
import assert from "node:assert/strict";
import { classifySubmit, deriveShellModeTransition } from "../src/shell-mode.js";

test("entering: leading `!` flips on and strips the prefix", () => {
  assert.deepEqual(
    deriveShellModeTransition(false, "!ls -la"),
    { mode: true, replaceText: "ls -la" },
  );
});

test("entering: bare `!` flips on with empty replacement", () => {
  assert.deepEqual(
    deriveShellModeTransition(false, "!"),
    { mode: true, replaceText: "" },
  );
});

test("entering: double `!!` strips only the leading char (next onChange is a no-op)", () => {
  assert.deepEqual(
    deriveShellModeTransition(false, "!!echo hi"),
    { mode: true, replaceText: "!echo hi" },
  );
});

test("non-leading `!` does not flip the mode", () => {
  assert.deepEqual(
    deriveShellModeTransition(false, "echo !foo"),
    { mode: false },
  );
});

test("plain text out of shell mode is a no-op", () => {
  assert.deepEqual(
    deriveShellModeTransition(false, "what is git?"),
    { mode: false },
  );
});

test("sticky: empty buffer in shell mode does NOT auto-exit", () => {
  // Regression guard — Editor.submitValue() fires onChange("") before onSubmit,
  // so auto-exit on empty would misroute the submit to the agent.
  assert.deepEqual(
    deriveShellModeTransition(true, ""),
    { mode: true },
  );
});

test("staying: non-empty text in shell mode does not strip or flip", () => {
  assert.deepEqual(
    deriveShellModeTransition(true, "ls"),
    { mode: true },
  );
});

test("staying: leading `!` while already in shell mode is treated as a literal char", () => {
  assert.deepEqual(
    deriveShellModeTransition(true, "!history"),
    { mode: true },
  );
});

test("recursive call after setText is a no-op (idempotent)", () => {
  const first = deriveShellModeTransition(false, "!ls");
  assert.equal(first.mode, true);
  assert.equal(first.replaceText, "ls");
  // Second call runs with the *old* mode — caller hasn't applied the transition yet.
  const second = deriveShellModeTransition(false, first.replaceText!);
  assert.deepEqual(second, { mode: false });
});

test("classifySubmit: empty text is noop", () => {
  assert.deepEqual(classifySubmit("", false), { kind: "noop" });
  assert.deepEqual(classifySubmit("   ", true), { kind: "noop" });
});

test("classifySubmit: shellMode routes non-empty text to the shell", () => {
  assert.deepEqual(
    classifySubmit("ls -la", true),
    { kind: "shell", line: "ls -la" },
  );
});

test("classifySubmit: shellMode wins over slash prefix", () => {
  assert.deepEqual(
    classifySubmit("/foo", true),
    { kind: "shell", line: "/foo" },
  );
});

test("classifySubmit: slash command parses name and args", () => {
  assert.deepEqual(
    classifySubmit("/help me", false),
    { kind: "command", name: "/help", args: "me" },
  );
  assert.deepEqual(
    classifySubmit("/help", false),
    { kind: "command", name: "/help", args: "" },
  );
});

test("classifySubmit: plain text becomes an agent submit", () => {
  assert.deepEqual(
    classifySubmit("what is git?", false),
    { kind: "agent", query: "what is git?" },
  );
});

test("classifySubmit: leading/trailing whitespace is trimmed", () => {
  assert.deepEqual(
    classifySubmit("  ls  ", true),
    { kind: "shell", line: "ls" },
  );
});
