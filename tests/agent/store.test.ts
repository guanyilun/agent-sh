import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  type Entry,
  InMemoryStore,
  NoopStore,
  FileStore,
  SharedFileStore,
  isTreeStore,
  newEntryId,
} from "../../src/agent/store.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "store-test-"));
});

afterEach(async () => {
  try { await fsp.rm(tmpDir, { recursive: true, force: true }); } catch {}
});

function makeEntry(kind: string, payload: Record<string, unknown> = {}, parentId?: string): Entry {
  return { id: newEntryId(), parentId, ts: Date.now(), kind, payload };
}

describe("NoopStore", () => {
  test("all operations resolve to empty/null", async () => {
    const s = new NoopStore();
    await s.append([makeEntry("user")]);
    assert.equal(await s.findById("anything"), null);
    assert.deepEqual(await s.readRecent(10), []);
    assert.deepEqual(await s.search("hi"), []);
  });
});

describe("InMemoryStore", () => {
  test("append + readRecent in order", async () => {
    const s = new InMemoryStore();
    const e1 = makeEntry("user", { sum: "first" });
    const e2 = makeEntry("agent", { sum: "second" });
    await s.append([e1, e2]);
    const recent = await s.readRecent();
    assert.deepEqual(recent.map((e) => e.id), [e1.id, e2.id]);
  });

  test("readRecent honors n", async () => {
    const s = new InMemoryStore();
    for (let i = 0; i < 5; i++) {
      await s.append([makeEntry("user", { sum: `entry ${i}` })]);
    }
    const recent = await s.readRecent(2);
    assert.equal(recent.length, 2);
    assert.equal((recent[0]!.payload as { sum: string }).sum, "entry 3");
    assert.equal((recent[1]!.payload as { sum: string }).sum, "entry 4");
  });

  test("findById returns entry or null", async () => {
    const s = new InMemoryStore();
    const e = makeEntry("user", { sum: "x" });
    await s.append([e]);
    assert.equal((await s.findById(e.id))?.id, e.id);
    assert.equal(await s.findById("missing"), null);
  });

  test("search matches kind/payload via JSON regex", async () => {
    const s = new InMemoryStore();
    await s.append([
      makeEntry("user", { sum: "blue widget" }),
      makeEntry("user", { sum: "red widget" }),
      makeEntry("agent", { sum: "tool ran" }),
    ]);
    const hits = await s.search("blue");
    assert.equal(hits.length, 1);
    assert.equal((hits[0]!.entry.payload as { sum: string }).sum, "blue widget");
  });

  test("implements TreeStore: getBranch walks parentId", async () => {
    const root = makeEntry("session");
    const s = new InMemoryStore({ root });
    assert.equal(isTreeStore(s), true);
    const c1 = makeEntry("message", {}, root.id);
    const c2 = makeEntry("message", {}, c1.id);
    await s.append([c1, c2]);
    s.setLeaf(c2.id);

    const branch = await s.getBranch();
    assert.deepEqual(branch.map((e) => e.id), [root.id, c1.id, c2.id]);
  });

  test("setLeaf throws for unknown id", () => {
    const root = makeEntry("session");
    const s = new InMemoryStore({ root });
    assert.throws(() => s.setLeaf("missing"), /unknown entry/);
  });
});

describe("FileStore", () => {
  test("writes JSONL and reads back round-trip", async () => {
    const file = path.join(tmpDir, "tree.jsonl");
    const root = makeEntry("session");
    const s = new FileStore({ filePath: file, root });
    const c1 = makeEntry("message", { message: { role: "user", content: "hi" } }, root.id);
    await s.append([c1]);
    s.setLeaf(c1.id);

    const reopened = new FileStore({ filePath: file });
    assert.equal(reopened.getLeaf(), c1.id);
    const branch = await reopened.getBranch();
    assert.deepEqual(branch.map((e) => e.id), [root.id, c1.id]);
  });

  test("ephemeral appends are not persisted", async () => {
    const file = path.join(tmpDir, "tree.jsonl");
    const root = makeEntry("session");
    const s = new FileStore({ filePath: file, root });
    const ephemeral = makeEntry("recall-cache", { fullMessage: "x" }, root.id);
    await s.append([ephemeral], { ephemeral: true });

    // In-memory: visible immediately.
    assert.notEqual(await s.findById(ephemeral.id), null);

    // On disk after reopen: gone.
    const reopened = new FileStore({ filePath: file });
    assert.equal(await reopened.findById(ephemeral.id), null);
  });

  test("getBranch walks back to root from leaf", async () => {
    const file = path.join(tmpDir, "tree.jsonl");
    const root = makeEntry("session");
    const s = new FileStore({ filePath: file, root });
    const a = makeEntry("message", {}, root.id);
    const b = makeEntry("message", {}, a.id);
    const c = makeEntry("message", {}, b.id);
    await s.append([a, b, c]);
    s.setLeaf(c.id);
    const branch = await s.getBranch();
    assert.deepEqual(branch.map((e) => e.id), [root.id, a.id, b.id, c.id]);
  });

  test("forks: two children of the same parent each form their own branch", async () => {
    const file = path.join(tmpDir, "tree.jsonl");
    const root = makeEntry("session");
    const s = new FileStore({ filePath: file, root });
    const trunk = makeEntry("message", {}, root.id);
    await s.append([trunk]);
    const branchA = makeEntry("message", { tag: "A" }, trunk.id);
    const branchB = makeEntry("message", { tag: "B" }, trunk.id);
    await s.append([branchA, branchB]);

    s.setLeaf(branchA.id);
    const ba = await s.getBranch();
    assert.deepEqual(ba.map((e) => e.id), [root.id, trunk.id, branchA.id]);

    s.setLeaf(branchB.id);
    const bb = await s.getBranch();
    assert.deepEqual(bb.map((e) => e.id), [root.id, trunk.id, branchB.id]);
  });
});

describe("SharedFileStore", () => {
  test("append + readRecent round-trips through disk", async () => {
    const file = path.join(tmpDir, "shared.jsonl");
    const s = new SharedFileStore({ filePath: file });
    const e1 = makeEntry("user", { sum: "first" });
    const e2 = makeEntry("agent", { sum: "second" });
    await s.append([e1, e2]);
    const recent = await s.readRecent();
    assert.deepEqual(recent.map((e) => e.id), [e1.id, e2.id]);

    const reopened = new SharedFileStore({ filePath: file });
    const recent2 = await reopened.readRecent();
    assert.deepEqual(recent2.map((e) => e.id), [e1.id, e2.id]);
  });

  test("ephemeral appends are a no-op", async () => {
    const file = path.join(tmpDir, "shared.jsonl");
    const s = new SharedFileStore({ filePath: file });
    const e = makeEntry("recall-cache", { fullMessage: "x" });
    await s.append([e], { ephemeral: true });
    const recent = await s.readRecent();
    assert.equal(recent.length, 0);
  });

  test("findById streams from tail", async () => {
    const file = path.join(tmpDir, "shared.jsonl");
    const s = new SharedFileStore({ filePath: file });
    const e1 = makeEntry("user", { sum: "needle" });
    await s.append([e1]);
    for (let i = 0; i < 100; i++) {
      await s.append([makeEntry("agent", { sum: `noise ${i}` })]);
    }
    assert.equal((await s.findById(e1.id))?.id, e1.id);
  });

  test("concurrent appends from two writers both land", async () => {
    const file = path.join(tmpDir, "shared.jsonl");
    const w1 = new SharedFileStore({ filePath: file });
    const w2 = new SharedFileStore({ filePath: file });

    const writes: Promise<void>[] = [];
    for (let i = 0; i < 50; i++) {
      writes.push(w1.append([makeEntry("user", { sum: `w1 ${i}` })]));
      writes.push(w2.append([makeEntry("user", { sum: `w2 ${i}` })]));
    }
    await Promise.all(writes);

    const reader = new SharedFileStore({ filePath: file });
    const recent = await reader.readRecent();
    assert.equal(recent.length, 100);
    const fromW1 = recent.filter((e) => (e.payload as { sum: string }).sum.startsWith("w1"));
    const fromW2 = recent.filter((e) => (e.payload as { sum: string }).sum.startsWith("w2"));
    assert.equal(fromW1.length, 50);
    assert.equal(fromW2.length, 50);
  });

  test("front-truncates when file exceeds 1.5× maxBytes", async () => {
    const file = path.join(tmpDir, "shared.jsonl");
    // Use a small cap so the test runs quickly.
    const s = new SharedFileStore({ filePath: file, maxBytes: 1024 });
    // Write enough to trigger truncation (each entry ~100 bytes).
    for (let i = 0; i < 60; i++) {
      await s.append([makeEntry("user", { sum: `entry-${i}-` + "x".repeat(80) })]);
    }
    const size = (await fsp.stat(file)).size;
    assert.ok(size <= 1024 * 1.5, `file size ${size} should be <= ${1024 * 1.5}`);

    // After truncation, the oldest entries are gone but recent ones survive.
    const recent = await s.readRecent();
    assert.ok(recent.length > 0);
    const sums = recent.map((e) => (e.payload as { sum: string }).sum);
    assert.ok(sums.some((s) => s.startsWith("entry-59-")), "newest entry should survive");
    assert.ok(!sums.some((s) => s.startsWith("entry-0-")), "oldest entry should be truncated");
  });

  test("search finds entries by regex over JSON", async () => {
    const file = path.join(tmpDir, "shared.jsonl");
    const s = new SharedFileStore({ filePath: file });
    await s.append([
      makeEntry("user", { sum: "alpha beta gamma" }),
      makeEntry("user", { sum: "delta epsilon" }),
      makeEntry("agent", { sum: "zeta gamma" }),
    ]);
    const hits = await s.search("gamma");
    assert.equal(hits.length, 2);
  });

  test("readRecent on empty file is empty", async () => {
    const file = path.join(tmpDir, "empty.jsonl");
    const s = new SharedFileStore({ filePath: file });
    assert.deepEqual(await s.readRecent(), []);
  });

  test("handles malformed lines without crashing", async () => {
    const file = path.join(tmpDir, "shared.jsonl");
    const s = new SharedFileStore({ filePath: file });
    await s.append([makeEntry("user", { sum: "good" })]);
    // Inject a malformed line directly.
    await fsp.appendFile(file, "{not json\n");
    await s.append([makeEntry("user", { sum: "after malformed" })]);
    const recent = await s.readRecent();
    // The two good entries survive; the malformed line is skipped.
    assert.equal(recent.length, 2);
  });
});
