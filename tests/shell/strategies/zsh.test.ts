import test from "node:test";
import assert from "node:assert/strict";
import { zshStrategy } from "../../../src/shell/strategies/zsh.js";

test("cleanOutput strips the PROMPT_SP inverse-`%` marker", () => {
  const raw = "hi\x1b[7m%\x1b[27m" + " ".repeat(40) + "\r";
  assert.equal(zshStrategy.cleanOutput!(raw), "hi" + " ".repeat(40) + "\r");
});

test("cleanOutput preserves a legitimate trailing `%` without inverse-video wrapper", () => {
  assert.equal(zshStrategy.cleanOutput!("done %"), "done %");
});
