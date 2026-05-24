/**
 * Unit tests for src/shell/terminal.ts.
 *
 * surfaceFromTerminal is pure (just routes through a Terminal), so we
 * exercise it directly with a recording fake.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { surfaceFromTerminal, type Terminal } from "../../src/shell/terminal.js";

interface Recording {
  writes: string[];
  resizeCbs: ((cols: number, rows: number) => void)[];
}

function makeFakeTerminal(initialCols = 100, initialRows = 30): Terminal & { _rec: Recording; _cols: number; _rows: number } {
  const rec: Recording = { writes: [], resizeCbs: [] };
  let cols = initialCols;
  let rows = initialRows;
  const t = {
    write(data: string) { rec.writes.push(data); },
    onInput(_cb: (s: string) => void) { return () => {}; },
    onResize(cb: (c: number, r: number) => void) {
      rec.resizeCbs.push(cb);
      return () => {
        const i = rec.resizeCbs.indexOf(cb);
        if (i >= 0) rec.resizeCbs.splice(i, 1);
      };
    },
    cols() { return cols; },
    rows() { return rows; },
    _rec: rec,
    get _cols() { return cols; },
    set _cols(v: number) { cols = v; },
    get _rows() { return rows; },
    set _rows(v: number) { rows = v; },
  };
  return t;
}

test("surfaceFromTerminal: translates lone \\n to \\r\\n on write", () => {
  const t = makeFakeTerminal();
  const surface = surfaceFromTerminal(t);
  surface.write("hello\nworld\n");
  assert.deepEqual(t._rec.writes, ["hello\r\nworld\r\n"]);
});

test("surfaceFromTerminal: preserves existing \\r\\n (no double-CR)", () => {
  const t = makeFakeTerminal();
  const surface = surfaceFromTerminal(t);
  surface.write("a\r\nb\n");
  assert.deepEqual(t._rec.writes, ["a\r\nb\r\n"]);
});

test("surfaceFromTerminal: writeLine appends \\n then translates", () => {
  const t = makeFakeTerminal();
  const surface = surfaceFromTerminal(t);
  surface.writeLine("hi");
  assert.deepEqual(t._rec.writes, ["hi\r\n"]);
});

test("surfaceFromTerminal: writeLine survives destructuring (no `this` self-reference)", () => {
  const t = makeFakeTerminal();
  const surface = surfaceFromTerminal(t);
  const { writeLine } = surface;
  writeLine("detached");
  assert.deepEqual(t._rec.writes, ["detached\r\n"]);
});

test("surfaceFromTerminal: columns/rows reflect terminal state at access time", () => {
  const t = makeFakeTerminal(80, 24);
  const surface = surfaceFromTerminal(t);
  assert.equal(surface.columns, 80);
  assert.equal(surface.rows, 24);
  t._cols = 132;
  t._rows = 50;
  assert.equal(surface.columns, 132);
  assert.equal(surface.rows, 50);
});

test("surfaceFromTerminal: onResize wires through to the underlying terminal", () => {
  const t = makeFakeTerminal();
  const surface = surfaceFromTerminal(t);
  const seen: Array<[number, number]> = [];
  const off = surface.onResize((c, r) => seen.push([c, r]));
  assert.equal(t._rec.resizeCbs.length, 1);

  t._rec.resizeCbs[0](120, 40);
  assert.deepEqual(seen, [[120, 40]]);

  off();
  assert.equal(t._rec.resizeCbs.length, 0);
});
