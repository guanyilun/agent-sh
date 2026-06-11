/** Kitty Unicode-placeholder encoding and the run-partitioning that keeps inline
 *  image ids aligned when the wrapper fuses adjacent runs or splits one across
 *  lines. Pure logic — no terminal required. */
import test from "node:test";
import assert from "node:assert/strict";
import {
  PLACEHOLDER,
  inlinePlaceholder,
  paintInlineImages,
  type InlineItem,
} from "../src/renderers/pi-tui/inline-image.js";
import { reserveSentinels } from "../src/renderers/pi-tui/nodes.js";

const D5 = String.fromCodePoint(0x033D); // DIACRITICS[5]
const D2 = String.fromCodePoint(0x030E); // DIACRITICS[2]
const countPH = (s: string): number => s.split(PLACEHOLDER).length - 1;
// Low-24-bit ids round-trip through the fg colour, so we can read placed ids back.
const fgIds = (s: string): number[] =>
  [...s.matchAll(/\x1b\[38;2;(\d+);(\d+);(\d+)m/g)].map(
    (m) => (Number(m[1]) << 16) | (Number(m[2]) << 8) | Number(m[3]),
  );

test("inlinePlaceholder encodes the id in the fg colour and reserves `count` cells", () => {
  const s = inlinePlaceholder(0x010203, 3);
  assert.ok(s.startsWith("\x1b[38;2;1;2;3m"), "fg carries the id's low 24 bits");
  assert.ok(s.endsWith("\x1b[39m"), "fg is reset at the end");
  assert.equal(countPH(s), 3, "one placeholder cell per column");
});

test("inlinePlaceholder offsets the column diacritic by colStart", () => {
  // DIACRITICS[5] = U+033D; a colStart of 5 must place it as the first column.
  assert.ok(!inlinePlaceholder(1, 1, 0).includes(D5));
  assert.ok(inlinePlaceholder(1, 1, 5).includes(D5));
});

test("paintInlineImages keeps ids aligned when adjacent images share one run", () => {
  // `$a$$b$` reserves one fused run of 2+3 placeholder cells.
  const line = PLACEHOLDER.repeat(5);
  const items: InlineItem[] = [{ id: 11, cols: 2 }, { id: 22, cols: 3 }];
  const transmits: Array<[number, number]> = [];
  const out = paintInlineImages([line], items, (id, cols) => transmits.push([id, cols]));

  assert.deepEqual(transmits, [[11, 2], [22, 3]], "each image transmitted once at its full width");
  assert.deepEqual(fgIds(out.join("")), [11, 22], "cells split 2/3 between the two ids, in order");
});

test("paintInlineImages keeps one image whole when the wrapper splits it across lines", () => {
  // A 4-col image whose run got broken into 2 + 2 on consecutive lines.
  const lines = [PLACEHOLDER.repeat(2), PLACEHOLDER.repeat(2)];
  const items: InlineItem[] = [{ id: 7, cols: 4 }];
  const transmits: Array<[number, number]> = [];
  const out = paintInlineImages(lines, items, (id, cols) => transmits.push([id, cols]));

  assert.deepEqual(transmits, [[7, 4]], "transmitted once, not once per line fragment");
  assert.deepEqual(fgIds(out.join("")), [7, 7], "both fragments belong to the same image");
  // Line 1 holds columns 0-1; the continuation holds columns 2-3 (DIACRITICS[2]).
  assert.ok(!out[0]!.includes(D2), "first fragment does not carry the column-2 diacritic");
  assert.ok(out[1]!.includes(D2), "continuation uses offset column indices, not a restart");
});

test("paintInlineImages places a normal single run and leaves surrounding text intact", () => {
  const out = paintInlineImages([`a${PLACEHOLDER.repeat(2)}b`], [{ id: 5, cols: 2 }], () => {});
  assert.deepEqual(fgIds(out.join("")), [5]);
  assert.ok(out[0]!.startsWith("a") && out[0]!.endsWith("b"), "text on either side is preserved");
});

test("paintInlineImages is a no-op with no items", () => {
  const lines = ["plain text", "more"];
  assert.equal(paintInlineImages(lines, [], () => {}), lines);
});

// The renderer subclass is always installed, but it must be a pass-through when
// no sentinels are present — i.e. when latex-images is off, or the terminal has
// no kitty support (so the sentinel producer never runs).
test("reserveSentinels leaves ordinary markdown untouched (latex-images off)", () => {
  const text = "**bold** _i_ `code` and a literal $ sign — 100% normal";
  const { display, items } = reserveSentinels(text);
  assert.equal(display, text, "text passes through verbatim");
  assert.deepEqual(items, [], "no inline images reserved");
});

test("reserveSentinels drops a stray sentinel for an unregistered id (no crash, no garbage)", () => {
  const { display, items } = reserveSentinels("a \x01LI:999\x01 b");
  assert.equal(display, "a  b", "unmatched sentinel is removed, not rendered");
  assert.deepEqual(items, []);
});
