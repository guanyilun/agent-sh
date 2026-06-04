import test from "node:test";
import assert from "node:assert/strict";

const { computeDiff } = await import("../../src/utils/diff.js");
const { renderDiff } = await import("../../src/utils/diff-renderer.js");

const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");
const old = "def add(a, b):\n    return a + b\n\nprint(add(1, 2))\n";
const neu = "def add(a, b):\n    return a + b\n\ndef mul(a, b):\n    return a * b\n\nprint(add(1, 2))\n";

test("gutterLine false: no pipe, space after sigil, line number leads", () => {
  const lines = renderDiff(computeDiff(old, neu), {
    width: 60, filePath: "x.py", mode: "unified", gutterLine: false,
  }).map(strip);
  const added = lines.find((l) => l.includes("def mul"));
  assert.ok(added, "added line present");
  assert.match(added!, /^\s*\d+ \+ def mul/); // `<n> + code`, space after sigil, no `│`
  assert.ok(!lines.some((l) => l.includes("│")), "no pipe rule with the flush gutter");
});

test("gutterLine defaults true: keeps the │ rule (pi-tui look unchanged)", () => {
  const lines = renderDiff(computeDiff(old, neu), {
    width: 60, filePath: "x.py", mode: "unified",
  }).map(strip);
  assert.ok(lines.some((l) => l.includes("│")), "default keeps the pipe rule");
});

test("unified wraps long lines instead of truncating, staying within width", () => {
  const longA = "x = " + "a".repeat(200);
  const longB = "x = " + "b".repeat(200);
  const width = 60;
  const lines = renderDiff(computeDiff(`p\n${longA}\nq\n`, `p\n${longB}\nq\n`), {
    width, filePath: "x.txt", mode: "unified", gutterLine: false, maxLines: Number.MAX_SAFE_INTEGER,
  }).map(strip);
  assert.ok(!lines.some((l) => l.includes("…")), "no truncation ellipsis");
  assert.ok(lines.filter((l) => /aa/.test(l)).length >= 2, "removed line wrapped across ≥2 rows");
  assert.ok(lines.filter((l) => /bb/.test(l)).length >= 2, "added line wrapped across ≥2 rows");
  for (const l of lines) assert.ok(l.length <= width, `row exceeds width ${width}: "${l}"`);
});

test("wrapped continuation rows omit the line number and sigil", () => {
  const longA = "y = " + "a".repeat(120);
  const lines = renderDiff(computeDiff("p\nkeep\nq\n", `p\n${longA}\nq\n`), {
    width: 40, filePath: "x.txt", mode: "unified", gutterLine: false, maxLines: Number.MAX_SAFE_INTEGER,
  }).map(strip);
  assert.ok(lines.some((l) => /^\s*\d+ \+ y =/.test(l)), "added line's first row keeps `<n> +`");
  const contRows = lines.filter((l) => /aa/.test(l));
  assert.ok(contRows.length >= 2, "long line wrapped across continuation rows");
  for (const cont of contRows) {
    assert.doesNotMatch(cont, /^\s*\d+ [-+]/, "continuation row has no line number/sigil");
  }
});
