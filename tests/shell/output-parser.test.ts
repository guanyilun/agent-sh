import test from "node:test";
import assert from "node:assert/strict";
import { EventBus } from "../../src/core/event-bus.js";
import { OutputParser } from "../../src/shell/output-parser.js";

const OWN = "deadbeef";
const FOREIGN = "cafebabe";

function makeParser(): { parser: OutputParser; bus: EventBus; events: Array<{ name: string; payload: unknown }> } {
  const bus = new EventBus();
  const events: Array<{ name: string; payload: unknown }> = [];
  bus.onAny((name, payload) => events.push({ name, payload }));
  const parser = new OutputParser(bus, "/start/cwd", OWN);
  return { parser, bus, events };
}

function osc(num: number, tag: string, body: string): string {
  return `\x1b]${num};id=${tag};${body}\x07`;
}

// ── OSC 7 (cwd tracking) ─────────────────────────────────────────

test("OSC 7 with a new path updates cwd and emits shell:cwd-change", () => {
  const { parser, events } = makeParser();
  parser.processData("\x1b]7;file://host/new/path\x07");
  assert.equal(parser.getCwd(), "/new/path");
  const cwd = events.find((e) => e.name === "shell:cwd-change");
  assert.deepEqual(cwd?.payload, { cwd: "/new/path" });
});

test("OSC 7 with the same path does not re-emit shell:cwd-change", () => {
  const { parser, events } = makeParser();
  parser.processData("\x1b]7;file://host/start/cwd\x07");
  assert.equal(events.filter((e) => e.name === "shell:cwd-change").length, 0);
});

test("OSC 7 decodes percent-encoded paths", () => {
  const { parser, events } = makeParser();
  parser.processData("\x1b]7;file://host/has%20space/dir\x07");
  assert.equal(parser.getCwd(), "/has space/dir");
  const cwd = events.find((e) => e.name === "shell:cwd-change");
  assert.deepEqual(cwd?.payload, { cwd: "/has space/dir" });
});

// ── OSC 9997 (preexec / command-start) ──────────────────────────

test("OSC 9997 with own tag emits shell:command-start with the carried command text", () => {
  const { parser, events } = makeParser();
  parser.processData(osc(9997, OWN, "ls -la"));
  const start = events.find((e) => e.name === "shell:command-start");
  assert.deepEqual(start?.payload, { command: "ls -la", cwd: "/start/cwd" });
});

test("OSC 9997 with own tag flips foreground-busy true exactly once", () => {
  const { parser, events } = makeParser();
  parser.processData(osc(9997, OWN, "ls"));
  parser.processData(osc(9997, OWN, "pwd"));
  const busy = events.filter((e) => e.name === "shell:foreground-busy");
  assert.equal(busy.length, 1);
  assert.deepEqual(busy[0]?.payload, { busy: true });
});

test("OSC 9997 with a foreign tag does not fire command-start or foreground-busy", () => {
  const { parser, events } = makeParser();
  parser.processData(osc(9997, FOREIGN, "nested-ls"));
  assert.equal(events.filter((e) => e.name === "shell:command-start").length, 0);
  assert.equal(events.filter((e) => e.name === "shell:foreground-busy").length, 0);
});

test("OSC 9997 is stripped from the captured output buffer so it never reaches command-done", () => {
  const { parser, events } = makeParser();
  parser.processData(`prefix${osc(9997, OWN, "ls")}body${osc(9999, OWN, "PROMPT")}`);
  const done = events.find((e) => e.name === "shell:command-done") as { payload: { output: string } } | undefined;
  assert.ok(done);
  // Echoed-command stripping removes the first line ("ls"), leaving "body".
  assert.equal(done!.payload.output.includes("\x1b]"), false);
});

// ── OSC 9999 (prompt marker / command-done) ─────────────────────

test("OSC 9999 with own tag fires shell:command-done with stripped output and clears foreground-busy", () => {
  const { parser, events } = makeParser();
  parser.processData(osc(9997, OWN, "echo hello"));
  parser.processData("hello\n");
  parser.processData(osc(9999, OWN, "PROMPT"));

  const done = events.find((e) => e.name === "shell:command-done") as
    | { payload: { command: string; output: string; cwd: string; exitCode: number | null } }
    | undefined;
  assert.ok(done);
  assert.equal(done!.payload.command, "echo hello");
  assert.equal(done!.payload.output, "hello");
  assert.equal(done!.payload.cwd, "/start/cwd");
  assert.equal(done!.payload.exitCode, null);

  const busyEvents = events.filter((e) => e.name === "shell:foreground-busy");
  assert.equal((busyEvents.at(-1)?.payload as { busy: boolean }).busy, false);
});

test("OSC 9999 with a foreign tag does not fire command-done and keeps capturing into the buffer", () => {
  const { parser, events } = makeParser();
  parser.processData(osc(9997, OWN, "real-cmd"));
  parser.processData(`some-output${osc(9999, FOREIGN, "PROMPT")}more-output`);
  parser.processData(osc(9999, OWN, "PROMPT"));

  const dones = events.filter((e) => e.name === "shell:command-done");
  assert.equal(dones.length, 1, "exactly one command-done — from the own-tag prompt");
  const payload = dones[0]!.payload as { output: string; command: string };
  assert.equal(payload.command, "real-cmd");
  assert.ok(payload.output.includes("more-output"));
});

test("OSC 9999 without a prior command does not emit command-done", () => {
  const { parser, events } = makeParser();
  parser.processData(osc(9999, OWN, "PROMPT"));
  assert.equal(events.filter((e) => e.name === "shell:command-done").length, 0);
});

// ── OSC 9998 (prompt-ready) ─────────────────────────────────────

test("OSC 9998 with own tag flips isPromptReady() to true", () => {
  const { parser } = makeParser();
  assert.equal(parser.isPromptReady(), false);
  parser.processData(osc(9998, OWN, "READY"));
  assert.equal(parser.isPromptReady(), true);
});

test("OSC 9998 with a foreign tag does NOT flip isPromptReady()", () => {
  const { parser } = makeParser();
  parser.processData(osc(9998, FOREIGN, "READY"));
  assert.equal(parser.isPromptReady(), false);
});

test("OSC 9999 (own tag) resets promptReady — a new command is starting", () => {
  const { parser } = makeParser();
  parser.processData(osc(9998, OWN, "READY"));
  assert.equal(parser.isPromptReady(), true);
  parser.processData(osc(9999, OWN, "PROMPT"));
  assert.equal(parser.isPromptReady(), false);
});

// ── onCommandEntered (the legacy line-buffer path) ──────────────

test("onCommandEntered emits shell:command-start and flips foreground-busy true", () => {
  const { parser, events } = makeParser();
  parser.onCommandEntered("vim file", "/work");
  const start = events.find((e) => e.name === "shell:command-start");
  assert.deepEqual(start?.payload, { command: "vim file", cwd: "/work" });
  const busy = events.find((e) => e.name === "shell:foreground-busy");
  assert.deepEqual(busy?.payload, { busy: true });
});

// ── Buffer growth guard ─────────────────────────────────────────

test("output capture is capped — a runaway program does not grow the buffer unboundedly", () => {
  const { parser, events } = makeParser();
  parser.onCommandEntered("noisy", "/work");
  const big = "x".repeat(200 * 1024);
  parser.processData(big);
  parser.processData(osc(9999, OWN, "PROMPT"));
  const done = events.find((e) => e.name === "shell:command-done") as
    | { payload: { output: string } }
    | undefined;
  assert.ok(done);
  // Cap is 128 KB; the captured output must not exceed that meaningfully.
  assert.ok(done!.payload.output.length <= 128 * 1024);
});

// ── zsh PROMPT_SP marker ────────────────────────────────────────

test("zsh PROMPT_SP inverse-`%` marker is stripped from command-done output", () => {
  const { parser, events } = makeParser();
  parser.onCommandEntered("printf hi", "/work");
  // zsh prints PROMPT_EOL_MARK wrapped in inverse-video + padding + \r
  // before the prompt OSC marker when output didn't end at column 0.
  parser.processData("hi\x1b[7m%\x1b[27m" + " ".repeat(40) + "\r");
  parser.processData(osc(9999, OWN, "PROMPT"));
  const done = events.find((e) => e.name === "shell:command-done") as
    | { payload: { output: string } }
    | undefined;
  assert.equal(done?.payload.output, "hi");
});

test("legitimate trailing `%` in output is preserved (no inverse-video wrapper)", () => {
  const { parser, events } = makeParser();
  parser.onCommandEntered("printf 'done %%'", "/work");
  parser.processData("done %");
  parser.processData(osc(9999, OWN, "PROMPT"));
  const done = events.find((e) => e.name === "shell:command-done") as
    | { payload: { output: string } }
    | undefined;
  assert.equal(done?.payload.output, "done %");
});
