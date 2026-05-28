import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import EventEmitter from "node:events";

import { migrateFromLegacy } from "../../../../src/agent/extensions/rolling-history/index.js";

function makeNuclearLine(opts: {
  seq: number;
  ts?: number;
  iid?: string;
  kind?: string;
  tool?: string;
  sum?: string;
  body?: string;
}): string {
  return JSON.stringify({
    seq: opts.seq,
    ts: opts.ts ?? Date.now(),
    iid: opts.iid ?? "a1b2",
    kind: opts.kind ?? "tool",
    tool: opts.tool,
    sum: opts.sum ?? "test entry",
    body: opts.body,
  });
}

function fakeBus(): { bus: EventEmitter } {
  return { bus: new EventEmitter() };
}

test("migrates entries from legacy history file", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "rh-migrate-"));
  const storeDir = path.join(tmpDir, "rolling-history");
  fs.mkdirSync(storeDir, { recursive: true });

  try {
    const legacyPath = path.join(tmpDir, "history");
    const entry1 = makeNuclearLine({ seq: 1, sum: "first entry", body: "body one" });
    const entry2 = makeNuclearLine({ seq: 2, kind: "user", sum: 'user: "hello"' });
    const entry3 = makeNuclearLine({ seq: 3, tool: "read_file", sum: "read_file foo.txt", body: "file contents" });
    fs.writeFileSync(legacyPath, [entry1, entry2, entry3].join("\n") + "\n");

    const historyFile = path.join(storeDir, "history.jsonl");
    assert.ok(!fs.existsSync(historyFile), "new file should not exist before migration");

    migrateFromLegacy(storeDir, legacyPath, fakeBus());

    // New file should exist and contain 2 entries (read_file filtered out).
    assert.ok(fs.existsSync(historyFile), "new file should exist after migration");
    const lines = fs.readFileSync(historyFile, "utf-8").trim().split("\n");
    assert.equal(lines.length, 2, "should have 2 entries (read-only tool filtered)");

    // Verify entry shape.
    const parsed0 = JSON.parse(lines[0]!);
    assert.ok(typeof parsed0.id === "string" && parsed0.id.length === 8, "id should be 8-char hex");
    assert.equal(typeof parsed0.ts, "number");
    assert.equal(parsed0.kind, "tool");
    assert.ok(typeof parsed0.payload === "object");
    assert.equal(parsed0.payload.sum, "first entry");
    assert.equal(parsed0.payload.body, "body one");

    // Sentinel should exist.
    assert.ok(fs.existsSync(path.join(storeDir, ".migrated")), "sentinel should be created");

    // Legacy file untouched.
    assert.ok(fs.existsSync(legacyPath), "legacy file should not be deleted");
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }
});

test("skips migration when sentinel exists", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "rh-sentinel-"));
  const storeDir = path.join(tmpDir, "rolling-history");
  fs.mkdirSync(storeDir, { recursive: true });

  try {
    const legacyPath = path.join(tmpDir, "history");
    fs.writeFileSync(legacyPath, makeNuclearLine({ seq: 1 }) + "\n");
    fs.writeFileSync(path.join(storeDir, ".migrated"), "");

    migrateFromLegacy(storeDir, legacyPath, fakeBus());

    const historyFile = path.join(storeDir, "history.jsonl");
    const size = fs.existsSync(historyFile) ? fs.statSync(historyFile).size : 0;
    assert.equal(size, 0, "new file should be empty when sentinel blocked migration");
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }
});

test("skips migration when legacy file doesn't exist", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "rh-no-legacy-"));
  const storeDir = path.join(tmpDir, "rolling-history");
  fs.mkdirSync(storeDir, { recursive: true });

  try {
    const legacyPath = path.join(tmpDir, "history"); // does not exist
    migrateFromLegacy(storeDir, legacyPath, fakeBus());

    assert.ok(fs.existsSync(path.join(storeDir, ".migrated")), "sentinel should be created even when no legacy file");
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }
});

test("skips migration when new file already has content", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "rh-new-content-"));
  const storeDir = path.join(tmpDir, "rolling-history");
  fs.mkdirSync(storeDir, { recursive: true });

  try {
    const legacyPath = path.join(tmpDir, "history");
    fs.writeFileSync(legacyPath, makeNuclearLine({ seq: 1 }) + "\n");

    const historyFile = path.join(storeDir, "history.jsonl");
    fs.writeFileSync(historyFile, "existing content\n");

    migrateFromLegacy(storeDir, legacyPath, fakeBus());

    const content = fs.readFileSync(historyFile, "utf-8");
    assert.equal(content, "existing content\n", "new file should be untouched when it already has content");
    assert.ok(fs.existsSync(path.join(storeDir, ".migrated")), "sentinel should be created");
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }
});

test("survives malformed lines in the legacy file", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "rh-malform-"));
  const storeDir = path.join(tmpDir, "rolling-history");
  fs.mkdirSync(storeDir, { recursive: true });

  try {
    const legacyPath = path.join(tmpDir, "history");
    const lines = [
      makeNuclearLine({ seq: 1, sum: "good entry" }),
      "not valid json at all",
      makeNuclearLine({ seq: 2, kind: "user", sum: 'user: "another good"' }),
      '{ "seq": 3 }', // valid JSON but no "sum" field → deserializeEntry returns null
    ];
    fs.writeFileSync(legacyPath, lines.join("\n") + "\n");

    migrateFromLegacy(storeDir, legacyPath, fakeBus());

    const historyFile = path.join(storeDir, "history.jsonl");
    const content = fs.readFileSync(historyFile, "utf-8").trim().split("\n");
    assert.equal(content.length, 2, "only well-formed nuclear entries should be migrated");
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }
});
