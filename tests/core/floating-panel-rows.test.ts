import test from "node:test";
import assert from "node:assert/strict";

import { EventBus } from "../../src/core/event-bus.js";
import { FloatingPanel } from "../../src/utils/floating-panel.js";
import { stripCursorControls } from "../../src/utils/ansi.js";

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

test("stripCursorControls keeps SGR, drops cursor-moving bytes", () => {
  assert.equal(stripCursorControls(`${DIM}hello${RESET}`), `${DIM}hello${RESET}`);
  assert.equal(stripCursorControls("line\r"), "line");
  assert.equal(stripCursorControls("a\x1b[3Ab"), "ab");
  assert.equal(stripCursorControls("a\x1b[2Kb"), "ab");
  assert.equal(stripCursorControls("a\x1b]0;title\x07b"), "ab");
  assert.equal(stripCursorControls("a\x1b7b\x1b8c"), "abc");
  assert.equal(stripCursorControls("a\tb"), "a b");
  assert.equal(stripCursorControls("a\bb\x00c"), "abc");
});

test("build-row paints a CRLF-derived line without a stray carriage return", () => {
  const panel = new FloatingPanel(new EventBus(), {
    trigger: "\x1c",
    dimBackground: false,
  });

  // What tui:render-command-output produces for an ssh warning whose
  // trailing \r survived a split("\n") on CRLF output.
  const line = `${DIM}  ** WARNING: connection is not using a post-quantum key exchange algorithm.\r${RESET}`;
  const row: string = panel.handlers.call("panel:build-row", line, 96);

  assert.ok(!row.includes("\r"), "row must not contain a carriage return");
  assert.ok(row.includes("** WARNING: connection"));
  assert.equal(stripAnsiLen(row), 96);
});

test("build-row width math matches painted width when controls are stripped", () => {
  const panel = new FloatingPanel(new EventBus(), {
    trigger: "\x1c",
    dimBackground: false,
  });

  const row: string = panel.handlers.call("panel:build-row", "ok\r\x1b[5D", 10);
  assert.equal(row, "ok" + " ".repeat(8));
});

function stripAnsiLen(s: string): number {
  return s.replace(/\x1b\[[^m]*m/g, "").length;
}
