/** Inline `$…$` detection rules in the latex-images extension: prose, currency,
 *  escapes, and code spans must not false-match; real inline math must. */
import test from "node:test";
import assert from "node:assert/strict";
import { matchInline, replaceInline } from "../../examples/extensions/latex-images.js";

// Sequential ids so the sentinel for each matched span is identifiable.
function withCounter(): (eq: string) => number {
  let n = 0;
  return () => n++;
}
const SENT = (id: number): string => `\x01LI:${id}\x01`;

test("matchInline accepts a simple inline expression", () => {
  const m = matchInline("$x$", 0);
  assert.deepEqual(m, { eq: "x", end: 3 });
});

test("matchInline rejects a space right after the opening $", () => {
  assert.equal(matchInline("$ x$", 0), null);
});

test("matchInline rejects a space right before the closing $", () => {
  assert.equal(matchInline("$x $", 0), null);
});

test("matchInline rejects a digit right after the closing $ (currency)", () => {
  assert.equal(matchInline("$x$5", 0), null);
});

test("matchInline rejects multi-line spans", () => {
  assert.equal(matchInline("$x\ny$", 0), null);
});

test("matchInline honours backslash-escaped dollars inside the span", () => {
  // The \$ is consumed as part of the equation, not treated as the closer.
  const m = matchInline("$a\\$b$", 0);
  assert.deepEqual(m, { eq: "a\\$b", end: 6 });
});

test("replaceInline rewrites real inline math to a sentinel", () => {
  assert.equal(replaceInline("let $x$ be", withCounter()), `let ${SENT(0)} be`);
});

test("replaceInline leaves currency untouched", () => {
  assert.equal(replaceInline("$5 and $10 total", withCounter()), "$5 and $10 total");
});

test("replaceInline skips inline code spans (single and multi backtick)", () => {
  assert.equal(replaceInline("use `$x$` here", withCounter()), "use `$x$` here");
  assert.equal(replaceInline("use ``a $x$ b`` here", withCounter()), "use ``a $x$ b`` here");
});

test("replaceInline keeps scanning after an unmatched backtick", () => {
  // A lone backtick is literal; the $y$ after it must still be rewritten.
  assert.equal(replaceInline("a ` then $y$", withCounter()), `a \` then ${SENT(0)}`);
});

test("replaceInline does not treat escaped dollars as math", () => {
  assert.equal(replaceInline("cost \\$5 each", withCounter()), "cost \\$5 each");
});

test("replaceInline falls back to literal text when register returns null", () => {
  assert.equal(replaceInline("let $x$ be", () => null), "let $x$ be");
});

test("replaceInline handles multiple spans in order", () => {
  assert.equal(
    replaceInline("$a$ and $b$", withCounter()),
    `${SENT(0)} and ${SENT(1)}`,
  );
});
