/**
 * Strategy ↔ parser format-agreement tests.
 *
 * The bytes that each shell strategy makes the shell print MUST match the
 * regexes that OutputParser uses. If someone changes the OSC number on one
 * side but forgets the other, both unit-test suites still pass — but the
 * integration is broken. These tests close that gap.
 *
 * Each test:
 *   1. asks the strategy what it would emit (by simulating its printf format)
 *   2. feeds the resulting bytes into a real OutputParser
 *   3. asserts the parser fires the corresponding event
 */
import test from "node:test";
import assert from "node:assert/strict";
import { EventBus } from "../../src/core/event-bus.js";
import { OutputParser } from "../../src/shell/output-parser.js";
import { bashStrategy } from "../../src/shell/strategies/bash.js";
import { zshStrategy } from "../../src/shell/strategies/zsh.js";
import { fishStrategy } from "../../src/shell/strategies/fish.js";
import type { ShellStrategy } from "../../src/shell/strategies/index.js";

const STRATEGIES: ShellStrategy[] = [bashStrategy, zshStrategy, fishStrategy];

const TAG_HEX = "abc12345";
const INSTANCE_TAG = `id=${TAG_HEX}`;

function collectEvents(bus: EventBus): Array<{ name: string; payload: unknown }> {
  const events: Array<{ name: string; payload: unknown }> = [];
  bus.onAny((name, payload) => events.push({ name, payload }));
  return events;
}

/**
 * What the shell's `printf` would actually emit when interpreting the
 * escapes in the strategy's rc file. Mirrors the format the strategies
 * use: \e]<num>;<instanceTag>;<body>\a
 */
function emit(num: number, body: string): string {
  return `\x1b]${num};${INSTANCE_TAG};${body}\x07`;
}

for (const strategy of STRATEGIES) {
  test(`${strategy.name}: OSC 9999 (PROMPT) format is what OutputParser expects`, () => {
    const bus = new EventBus();
    const events = collectEvents(bus);
    const parser = new OutputParser(bus, "/start", INSTANCE_TAG);

    // Simulate a fully-formed command cycle so command-done can fire.
    parser.processData(emit(9997, "ls"));
    parser.processData("ls\nfile1 file2\n");
    parser.processData(emit(9999, "PROMPT"));

    const done = events.find((e) => e.name === "shell:command-done");
    assert.ok(done, `${strategy.name}: PROMPT marker did not trigger command-done`);
  });

  test(`${strategy.name}: OSC 9997 (PREEXEC) format is what OutputParser expects`, () => {
    const bus = new EventBus();
    const events = collectEvents(bus);
    const parser = new OutputParser(bus, "/start", INSTANCE_TAG);

    parser.processData(emit(9997, "make build"));

    const start = events.find((e) => e.name === "shell:command-start") as
      | { payload: { command: string } }
      | undefined;
    assert.ok(start, `${strategy.name}: PREEXEC marker did not trigger command-start`);
    assert.equal(start!.payload.command, "make build");
  });

  test(`${strategy.name}: OSC 9998 (READY) format is what OutputParser expects`, () => {
    const bus = new EventBus();
    const parser = new OutputParser(bus, "/start", INSTANCE_TAG);

    parser.processData(emit(9998, "READY"));
    assert.equal(parser.isPromptReady(), true, `${strategy.name}: READY marker did not flip promptReady`);
  });

  test(`${strategy.name}: OSC 7 (cwd) format is what OutputParser expects`, () => {
    const bus = new EventBus();
    const events = collectEvents(bus);
    const parser = new OutputParser(bus, "/start", INSTANCE_TAG);

    // OSC 7 is shared across all three strategies — they all emit
    // `\e]7;file://<host><path>\a`.
    parser.processData("\x1b]7;file://host/work/dir\x07");
    assert.equal(parser.getCwd(), "/work/dir");
    const cwd = events.find((e) => e.name === "shell:cwd-change");
    assert.deepEqual(cwd?.payload, { cwd: "/work/dir" });
  });
}

// ── Nested-instance isolation ─────────────────────────────────────
// Two agent-sh instances sharing the same PTY stream (e.g. ssh from
// agent-sh into another host running agent-sh) must not cross-trigger
// each other's command boundary detection.

test("two parsers with distinct tags do not cross-trigger on each other's markers", () => {
  const TAG_A = "id=aaaaaaaa";
  const TAG_B = "id=bbbbbbbb";

  const busA = new EventBus();
  const busB = new EventBus();
  const eventsA = collectEvents(busA);
  const eventsB = collectEvents(busB);
  const parserA = new OutputParser(busA, "/a", TAG_A);
  const parserB = new OutputParser(busB, "/b", TAG_B);

  // Merged stream delivered as separate chunks (matches real PTY behavior —
  // each `data` callback typically carries one marker plus surrounding text).
  const chunks = [
    `\x1b]9997;${TAG_A};only-A-runs\x07`,         // A's PREEXEC
    "output-line\n",
    `\x1b]9999;${TAG_B};PROMPT\x07`,              // foreign — A must ignore, B must ignore (no lastCommand)
    `\x1b]9998;${TAG_B};READY\x07`,               // foreign for A, own for B
    `\x1b]9999;${TAG_A};PROMPT\x07`,              // own for A — finalizes, foreign for B
  ];
  for (const c of chunks) {
    parserA.processData(c);
    parserB.processData(c);
  }

  // Parser A: saw exactly one command-start (its own PREEXEC) and one
  // command-done (its own PROMPT). The foreign markers between them did
  // not split the command in half.
  const aStarts = eventsA.filter((e) => e.name === "shell:command-start");
  const aDones = eventsA.filter((e) => e.name === "shell:command-done");
  assert.equal(aStarts.length, 1, "A: expected exactly one command-start");
  assert.equal(aDones.length, 1, "A: expected exactly one command-done");
  assert.equal((aStarts[0]!.payload as { command: string }).command, "only-A-runs");
  assert.equal(parserA.isPromptReady(), false, "A: foreign READY must not flip its promptReady");

  // Parser B: never saw a PREEXEC of its own, so no command-start, and
  // no command-done (no lastCommand to finalize). It DID see its own
  // PROMPT and READY — those just don't carry any pending command.
  const bStarts = eventsB.filter((e) => e.name === "shell:command-start");
  const bDones = eventsB.filter((e) => e.name === "shell:command-done");
  assert.equal(bStarts.length, 0, "B: must not pick up A's PREEXEC");
  assert.equal(bDones.length, 0, "B: must not pick up A's PROMPT");
  assert.equal(parserB.isPromptReady(), true, "B: its own READY must flip promptReady");
});
