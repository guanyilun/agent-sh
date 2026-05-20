import test from "node:test";
import assert from "node:assert/strict";
import { mergeShellEnv } from "../../src/cli/shell-env.js";

test("baseEnv values win over shellEnv when both define the key with a non-empty value", () => {
  const merged = mergeShellEnv({ FOO: "base" }, { FOO: "shell" });
  assert.equal(merged.FOO, "base");
});

test("shellEnv fills in keys missing from baseEnv", () => {
  const merged = mergeShellEnv({ A: "1" }, { B: "2" });
  assert.deepEqual(merged, { A: "1", B: "2" });
});

test("shellEnv fills in keys whose baseEnv value is the empty string", () => {
  const merged = mergeShellEnv({ FOO: "" }, { FOO: "shell" });
  assert.equal(merged.FOO, "shell");
});

test("merge does not mutate the inputs", () => {
  const base = { A: "1" };
  const shell = { B: "2" };
  mergeShellEnv(base, shell);
  assert.deepEqual(base, { A: "1" });
  assert.deepEqual(shell, { B: "2" });
});

test("empty baseEnv returns a copy of shellEnv", () => {
  const merged = mergeShellEnv({}, { X: "y" });
  assert.deepEqual(merged, { X: "y" });
});

test("empty shellEnv returns a copy of baseEnv", () => {
  const merged = mergeShellEnv({ X: "y" }, {});
  assert.deepEqual(merged, { X: "y" });
});
