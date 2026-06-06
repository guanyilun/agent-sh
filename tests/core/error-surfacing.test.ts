import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppConfig } from "../../src/shell/host-types.js";

process.env.AGENT_SH_HOME = mkdtempSync(join(tmpdir(), "agent-sh-core-test-"));

const { createCore } = await import("../../src/core/index.js");

test("a faulting listener is surfaced on ui:error", () => {
  const core = createCore({} as AppConfig);
  const errors: string[] = [];
  core.bus.on("ui:error", (e) => errors.push(e.message));

  core.bus.on("ui:info", () => { throw new Error("kaboom"); });
  core.bus.emit("ui:info", { message: "x" });

  assert.equal(errors.length, 1);
  assert.match(errors[0], /ui:info/);
  assert.match(errors[0], /kaboom/);
});

test("a faulting ui:error renderer does not loop back through the reporter", () => {
  const core = createCore({} as AppConfig);
  let renders = 0;
  core.bus.on("ui:error", () => { renders++; throw new Error("renderer down"); });

  core.bus.on("ui:info", () => { throw new Error("kaboom"); });
  assert.doesNotThrow(() => core.bus.emit("ui:info", { message: "x" }));
  assert.equal(renders, 1);
});
