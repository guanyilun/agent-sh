/** updateSettings never clobbers a settings file it could not parse. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "agent-sh-settings-write-"));
process.env.AGENT_SH_HOME = home;
const { updateSettings } = await import("../../src/core/settings.js");
const file = join(home, "settings.json");
test.after(() => rmSync(home, { recursive: true, force: true }));

test("missing file is created", () => {
  rmSync(file, { force: true });
  assert.equal(updateSettings({ defaultBackend: "ash" }), true);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf-8")), { defaultBackend: "ash" });
});

test("valid file is merged", () => {
  writeFileSync(file, JSON.stringify({ providers: { a: { apiKey: "k" } } }));
  assert.equal(updateSettings({ providers: { a: { defaultModel: "m" } } }), true);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf-8")), { providers: { a: { apiKey: "k", defaultModel: "m" } } });
});

for (const [label, raw] of [["invalid JSON", "{ \"apiKey\": \"sk-secret\","], ["a JSON array", "[1, 2]"], ["JSON null", "null"]]) {
  test(`${label} is left unchanged and reported as not saved`, () => {
    writeFileSync(file, raw);
    assert.equal(updateSettings({ defaultBackend: "ash" }), false);
    assert.equal(readFileSync(file, "utf-8"), raw);
  });
}
