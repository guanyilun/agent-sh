import test from "node:test";
import assert from "node:assert/strict";
import { effectiveReasoningLevel, normalizeReasoningLevels } from "../../src/core/reasoning-levels.js";

test("normalize keeps known levels, weakest first, deduplicated", () => {
  assert.deepEqual(normalizeReasoningLevels(["max", "low", "ultra", "low", 3]), ["low", "max"]);
  assert.equal(normalizeReasoningLevels(["ultra"]), undefined);
  assert.equal(normalizeReasoningLevels("high"), undefined);
});

test("undeclared models get the preference unchanged", () => {
  assert.equal(effectiveReasoningLevel("xhigh", undefined), "xhigh");
});

test("declared levels: exact, nearest, ties go up, off passes through", () => {
  const deepseek = ["off", "high", "max"];
  assert.equal(effectiveReasoningLevel("high", deepseek), "high");
  assert.equal(effectiveReasoningLevel("xhigh", deepseek), "max");
  assert.equal(effectiveReasoningLevel("medium", deepseek), "high");
  assert.equal(effectiveReasoningLevel("low", deepseek), "high");
  const o3 = ["low", "medium", "high"];
  assert.equal(effectiveReasoningLevel("xhigh", o3), "high");
  assert.equal(effectiveReasoningLevel("max", o3), "high");
  assert.equal(effectiveReasoningLevel("off", o3), "off", "a model without off keeps the provider default");
  assert.equal(effectiveReasoningLevel("minimal", o3), "low");
});
