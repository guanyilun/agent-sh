import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_HOME = mkdtempSync(join(tmpdir(), "agent-sh-settings-test-"));
process.env.AGENT_SH_HOME = TEST_HOME;

const {
  getSettings,
  reloadSettings,
  setSessionOverlay,
  clearSessionOverlay,
  getSettingSource,
} = await import("../../src/core/settings.js");

const SETTINGS_PATH = join(TEST_HOME, "settings.json");

function writeSettings(obj: Record<string, unknown>): void {
  mkdirSync(TEST_HOME, { recursive: true });
  writeFileSync(SETTINGS_PATH, JSON.stringify(obj));
}

function clearSettings(): void {
  try { rmSync(SETTINGS_PATH); } catch {}
}

function reset(): void {
  clearSettings();
  delete process.env.AGENT_SH_AUTO_COMPACT;
  delete process.env.AGENT_SH_AUTO_COMPACT_THRESHOLD;
  reloadSettings();
}

test("autoCompact defaults to true, threshold to 0.5", () => {
  reset();
  const s = getSettings();
  assert.equal(s.autoCompact, true);
  assert.equal(s.autoCompactThreshold, 0.5);
  assert.equal(getSettingSource("autoCompact"), "default");
  assert.equal(getSettingSource("autoCompactThreshold"), "default");
});

test("settings.json overrides defaults", () => {
  reset();
  writeSettings({ autoCompact: false, autoCompactThreshold: 0.8 });
  reloadSettings();
  const s = getSettings();
  assert.equal(s.autoCompact, false);
  assert.equal(s.autoCompactThreshold, 0.8);
  assert.equal(getSettingSource("autoCompact"), "file");
  assert.equal(getSettingSource("autoCompactThreshold"), "file");
});

test("env vars override file", () => {
  reset();
  writeSettings({ autoCompact: false, autoCompactThreshold: 0.8 });
  process.env.AGENT_SH_AUTO_COMPACT = "on";
  process.env.AGENT_SH_AUTO_COMPACT_THRESHOLD = "0.3";
  reloadSettings();
  const s = getSettings();
  assert.equal(s.autoCompact, true);
  assert.equal(s.autoCompactThreshold, 0.3);
  assert.equal(getSettingSource("autoCompact"), "env");
  assert.equal(getSettingSource("autoCompactThreshold"), "env");
});

test("env var boolean parsing accepts on/off/true/false/1/0", () => {
  for (const [raw, expected] of [
    ["on", true], ["true", true], ["1", true],
    ["off", false], ["false", false], ["0", false],
    ["OFF", false], ["True", true],
  ] as const) {
    reset();
    process.env.AGENT_SH_AUTO_COMPACT = raw;
    reloadSettings();
    assert.equal(getSettings().autoCompact, expected, `raw=${raw}`);
  }
});

test("malformed env values fall through to file/default", () => {
  reset();
  writeSettings({ autoCompact: false });
  const origErr = console.error;
  const warnings: string[] = [];
  console.error = (msg: string) => warnings.push(String(msg));
  try {
    process.env.AGENT_SH_AUTO_COMPACT = "maybe";
    process.env.AGENT_SH_AUTO_COMPACT_THRESHOLD = "2.5";
    reloadSettings();
    const s = getSettings();
    assert.equal(s.autoCompact, false, "fell through to file");
    assert.equal(s.autoCompactThreshold, 0.5, "fell through to default");
    assert.equal(getSettingSource("autoCompact"), "file");
    assert.equal(getSettingSource("autoCompactThreshold"), "default");
    assert.ok(warnings.some((w) => w.includes("AGENT_SH_AUTO_COMPACT=")), "warned about bool");
    assert.ok(warnings.some((w) => w.includes("AGENT_SH_AUTO_COMPACT_THRESHOLD=")), "warned about float");
  } finally {
    console.error = origErr;
  }
});

test("session overlay beats env and file", () => {
  reset();
  writeSettings({ autoCompactThreshold: 0.8 });
  process.env.AGENT_SH_AUTO_COMPACT = "on";
  reloadSettings();

  setSessionOverlay({ autoCompact: false, autoCompactThreshold: 0.2 });
  const s = getSettings();
  assert.equal(s.autoCompact, false);
  assert.equal(s.autoCompactThreshold, 0.2);
  assert.equal(getSettingSource("autoCompact"), "session");
  assert.equal(getSettingSource("autoCompactThreshold"), "session");
});

test("clearSessionOverlay restores underlying layer", () => {
  reset();
  process.env.AGENT_SH_AUTO_COMPACT = "off";
  reloadSettings();

  setSessionOverlay({ autoCompact: true });
  assert.equal(getSettings().autoCompact, true);
  assert.equal(getSettingSource("autoCompact"), "session");

  clearSessionOverlay("autoCompact");
  assert.equal(getSettings().autoCompact, false);
  assert.equal(getSettingSource("autoCompact"), "env");
});

test("clearSessionOverlay with no args clears everything", () => {
  reset();
  setSessionOverlay({ autoCompact: false, autoCompactThreshold: 0.9 });
  clearSessionOverlay();
  const s = getSettings();
  assert.equal(s.autoCompact, true);
  assert.equal(s.autoCompactThreshold, 0.5);
});

test.after(() => {
  try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch {}
});
