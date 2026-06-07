/** AGENT_SH_DEFAULT_CONTEXT_WINDOW override of the fallback budget. */
import test from "node:test";
import assert from "node:assert/strict";
import { resolveDefaultContextWindow } from "../../src/agent/token-budget.js";

test("uses the env override when it is a positive integer", () => {
  assert.equal(resolveDefaultContextWindow({ AGENT_SH_DEFAULT_CONTEXT_WINDOW: "131072" }), 131072);
});

test("falls back to 60k when unset", () => {
  assert.equal(resolveDefaultContextWindow({}), 60_000);
});

test("falls back to 60k on non-numeric, fractional, zero, or negative values", () => {
  for (const v of ["abc", "12.5", "0", "-5", ""]) {
    assert.equal(
      resolveDefaultContextWindow({ AGENT_SH_DEFAULT_CONTEXT_WINDOW: v }),
      60_000,
      `value=${JSON.stringify(v)}`,
    );
  }
});
