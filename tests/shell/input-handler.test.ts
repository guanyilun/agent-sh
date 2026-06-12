import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_HOME = mkdtempSync(join(tmpdir(), "agent-sh-input-handler-test-"));
process.env.AGENT_SH_HOME = TEST_HOME;

const { InputHandler } = await import("../../src/shell/input-handler.js");
const { TuiInputView } = await import("../../src/shell/tui-input-view.js");
const { EventBus } = await import("../../src/core/event-bus.js");
const HISTORY_FILE = join(TEST_HOME, "input-history");

interface Harness {
  handler: InstanceType<typeof InputHandler>;
  bus: InstanceType<typeof EventBus>;
  submitted: string[];
  commands: { name: string; args: string }[];
}

function makeHarness(): Harness {
  const bus = new EventBus();
  const handlerMap = new Map<string, (...a: unknown[]) => unknown>();
  const surface = {
    write: () => {},
    writeLine: () => {},
    columns: 80,
    rows: 24,
    onResize: () => () => {},
  };
  const handler = new InputHandler({
    ctx: {
      isForegroundBusy: () => false,
      getCwd: () => "/tmp",
      isAgentActive: () => false,
      writeToPty: () => {},
      onCommandEntered: () => {},
      redrawPrompt: () => {},
      freshPrompt: () => {},
    },
    bus,
    handlers: {
      define: (name, fn) => { handlerMap.set(name, fn); },
      call: (name, ...a) => handlerMap.get(name)?.(...a),
    },
    onShowAgentInfo: () => ({ info: "" }),
    view: new TuiInputView(surface),
  });

  const submitted: string[] = [];
  const commands: { name: string; args: string }[] = [];
  bus.on("agent:submit", (e) => submitted.push(e.query));
  bus.on("command:execute", (e) => commands.push(e));
  bus.emit("input-mode:register", {
    id: "agent",
    trigger: ">",
    label: "agent",
    promptIcon: "❯",
    indicator: "●",
    onSubmit(query, b) { b.emit("agent:submit", { query }); },
    returnToSelf: true,
  });
  return { handler, bus, submitted, commands };
}

test.afterEach(() => {
  try { rmSync(HISTORY_FILE); } catch { /* noop */ }
});

test("multi-line bracketed paste submits resolved content", () => {
  const h = makeHarness();
  h.handler.handleInput(">");
  h.handler.handleInput("\x1b[200~line one\nline two\x1b[201~");
  h.handler.handleInput("\r");
  assert.deepEqual(h.submitted, ["line one\nline two"]);
});

test("multi-line paste starting with / goes to the agent, not command dispatch", () => {
  const h = makeHarness();
  h.handler.handleInput(">");
  h.handler.handleInput("\x1b[200~/usr/bin/env node\nsecond line\x1b[201~");
  h.handler.handleInput("\r");
  assert.deepEqual(h.commands, []);
  assert.deepEqual(h.submitted, ["/usr/bin/env node\nsecond line"]);
});

test("single-line slash query still dispatches as a command", () => {
  const h = makeHarness();
  h.handler.handleInput(">");
  for (const ch of "/model gpt-test") h.handler.handleInput(ch);
  h.handler.handleInput("\r");
  assert.deepEqual(h.commands, [{ name: "/model", args: "gpt-test" }]);
  assert.deepEqual(h.submitted, []);
});

test("multi-line history entries survive save/load round-trip", () => {
  const h = makeHarness();
  h.handler.handleInput(">");
  h.handler.handleInput("\x1b[200~with \\backslash\nand second line\x1b[201~");
  h.handler.handleInput("\r");

  const onDisk = readFileSync(HISTORY_FILE, "utf-8");
  assert.equal(onDisk, "with \\\\backslash\\nand second line\n");

  const h2 = makeHarness();
  h2.handler.handleInput(">");
  h2.handler.handleInput("\x1b[A"); // arrow-up: recall most recent entry
  h2.handler.handleInput("\r");
  assert.deepEqual(h2.submitted, ["with \\backslash\nand second line"]);
});

test("legacy unescaped history lines load as-is", () => {
  const h = makeHarness();
  h.handler.handleInput(">");
  for (const ch of "plain old entry") h.handler.handleInput(ch);
  h.handler.handleInput("\r");
  assert.equal(readFileSync(HISTORY_FILE, "utf-8"), "plain old entry\n");

  const h2 = makeHarness();
  h2.handler.handleInput(">");
  h2.handler.handleInput("\x1b[A");
  h2.handler.handleInput("\r");
  assert.deepEqual(h2.submitted, ["plain old entry"]);
});
