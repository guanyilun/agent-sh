import test from "node:test";
import assert from "node:assert/strict";
import { classifySubmit, deriveChangeHandlerResult, deriveShellModeTransition } from "../src/shell-mode.js";

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
  assert.deepEqual(classifySubmit("", false, false), { kind: "noop" });
  assert.deepEqual(classifySubmit("   ", true, false), { kind: "noop" });
});

test("classifySubmit: shellMode routes non-empty text to the shell", () => {
  assert.deepEqual(
    classifySubmit("ls -la", true, false),
    { kind: "shell", line: "ls -la", private: false },
  );
});

test("classifySubmit: shellMode wins over slash prefix", () => {
  assert.deepEqual(
    classifySubmit("/foo", true, false),
    { kind: "shell", line: "/foo", private: false },
  );
});

test("classifySubmit: pendingPrivate=true marks the shell submit private", () => {
  assert.deepEqual(
    classifySubmit("ls -la", true, true),
    { kind: "shell", line: "ls -la", private: true },
  );
});

test("classifySubmit: slash command parses name and args", () => {
  assert.deepEqual(
    classifySubmit("/help me", false, false),
    { kind: "command", name: "/help", args: "me" },
  );
  assert.deepEqual(
    classifySubmit("/help", false, false),
    { kind: "command", name: "/help", args: "" },
  );
});

test("classifySubmit: plain text becomes an agent submit", () => {
  assert.deepEqual(
    classifySubmit("what is git?", false, false),
    { kind: "agent", query: "what is git?" },
  );
});

test("classifySubmit: leading/trailing whitespace is trimmed", () => {
  assert.deepEqual(
    classifySubmit("  ls  ", true, false),
    { kind: "shell", line: "ls", private: false },
  );
});

// ── deriveChangeHandlerResult (onChange integration) ──

test("change: cold `!` enters mode WITHOUT private (regression)", () => {
  assert.deepEqual(
    deriveChangeHandlerResult(false, false, "!"),
    { mode: true, replaceText: "", pendingPrivate: false },
  );
});

test("change: cold `!cmd` paste enters mode without private", () => {
  assert.deepEqual(
    deriveChangeHandlerResult(false, false, "!cmd"),
    { mode: true, replaceText: "cmd", pendingPrivate: false },
  );
});

test("change: cold `!!cmd` paste enters mode AND strips both `!`s", () => {
  // Atomic `!!` (typically a paste) should leave only the command in the
  // editor and set the private signal — no `!` visible.
  assert.deepEqual(
    deriveChangeHandlerResult(false, false, "!!cmd"),
    { mode: true, replaceText: "cmd", pendingPrivate: true },
  );
});

test("change: in-mode typing `!` strips it and sets private", () => {
  // Regression: previously `!` showed literally; now it's input-suppressed
  // like the entry `!`, signalled only via the indicator.
  assert.deepEqual(
    deriveChangeHandlerResult(true, false, "!"),
    { mode: true, replaceText: "", pendingPrivate: true },
  );
});

test("change: in-mode `!ls` strips the `!` and sets private", () => {
  assert.deepEqual(
    deriveChangeHandlerResult(true, false, "!ls"),
    { mode: true, replaceText: "ls", pendingPrivate: true },
  );
});

test("change: private is sticky while editing in shell mode", () => {
  assert.deepEqual(
    deriveChangeHandlerResult(true, true, "ls -la"),
    { mode: true, pendingPrivate: true },
  );
});

test("change: private is sticky even when editor goes empty (regression)", () => {
  // Empty-text from the entry-strip's recursive onChange("") must NOT clear
  // the private signal, or the second `!` is immediately undone.
  assert.deepEqual(
    deriveChangeHandlerResult(true, true, ""),
    { mode: true, pendingPrivate: true },
  );
});

test("change: out of shell mode never sets private", () => {
  assert.deepEqual(
    deriveChangeHandlerResult(false, false, "what is git?"),
    { mode: false, pendingPrivate: false },
  );
});

test("change: private cannot persist outside shell mode", () => {
  // If somehow called with private=true and mode=false (shouldn't happen,
  // but guard the invariant), private collapses to false.
  assert.deepEqual(
    deriveChangeHandlerResult(false, true, "hello"),
    { mode: false, pendingPrivate: false },
  );
});
