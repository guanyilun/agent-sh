import test from "node:test";
import assert from "node:assert/strict";
import { formatSessionRow } from "../src/session-commands.js";

test("formatSessionRow flattens a multi-line preview so the picker row stays single-line", () => {
  const row = formatSessionRow(
    {
      id: "x",
      createdAt: 1_700_000_000_000,
      entryCount: 3,
      preview: "I'm reading about this:\n\n  some pasted\n  multi-line content",
    } as never,
    false,
  );
  assert.ok(!row.includes("\n"), "no newline in the picker row");
  assert.match(row, /I'm reading about this: some pasted multi-line content/);
  assert.match(row, /\(3\)$/);
});
