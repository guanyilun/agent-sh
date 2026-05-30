import test from "node:test";
import assert from "node:assert/strict";

const { computeDiff } = await import("../../src/utils/diff.js");
const { renderDiff } = await import("../../src/utils/diff-renderer.js");

const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");
const old = "def add(a, b):\n    return a + b\n\nprint(add(1, 2))\n";
const neu = "def add(a, b):\n    return a + b\n\ndef mul(a, b):\n    return a * b\n\nprint(add(1, 2))\n";

test("gutterLine false: no pipe, sigil hugs the code, line number leads", () => {
  const lines = renderDiff(computeDiff(old, neu), {
    width: 60, filePath: "x.py", mode: "unified", gutterLine: false,
  }).map(strip);
  const added = lines.find((l) => l.includes("def mul"));
  assert.ok(added, "added line present");
  assert.match(added!, /^\s*\d+ \+def mul/); // `<n> +code`, sigil hugging, no `│`
  assert.ok(!lines.some((l) => l.includes("│")), "no pipe rule with the flush gutter");
});

test("gutterLine defaults true: keeps the │ rule (pi-tui look unchanged)", () => {
  const lines = renderDiff(computeDiff(old, neu), {
    width: 60, filePath: "x.py", mode: "unified",
  }).map(strip);
  assert.ok(lines.some((l) => l.includes("│")), "default keeps the pipe rule");
});
