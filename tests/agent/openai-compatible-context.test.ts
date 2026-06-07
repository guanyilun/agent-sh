/** Context-window extraction from a /v1/models catalog entry. */
import test from "node:test";
import assert from "node:assert/strict";
import { catalogContextWindow } from "../../src/agent/providers/openai-compatible.js";

test("reads llama.cpp meta.n_ctx (loaded window, not the training ceiling)", () => {
  assert.equal(
    catalogContextWindow({ id: "m", meta: { n_ctx: 131072 }, max_model_len: 0 }),
    131072,
  );
});

test("reads vLLM max_model_len when meta is absent", () => {
  assert.equal(catalogContextWindow({ id: "m", max_model_len: 32768 }), 32768);
});

test("prefers meta.n_ctx over max_model_len when both are present", () => {
  assert.equal(
    catalogContextWindow({ id: "m", meta: { n_ctx: 8192 }, max_model_len: 32768 }),
    8192,
  );
});

test("returns undefined for a spec-only entry (backwards compatible)", () => {
  assert.equal(catalogContextWindow({ id: "m" }), undefined);
});

test("ignores non-positive values", () => {
  assert.equal(catalogContextWindow({ id: "m", meta: { n_ctx: 0 }, max_model_len: 0 }), undefined);
});
