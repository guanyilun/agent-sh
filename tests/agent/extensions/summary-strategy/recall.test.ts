import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { InMemoryStore, newEntryId, type Entry } from "../../../../src/agent/store.js";
import { recallSearch, recallExpand, recallBrowse } from "../../../../src/agent/extensions/summary-strategy/recall.js";

function summaryEntry(opts: { sum: string; body?: string; kind?: string; id?: string }): Entry {
  return {
    id: opts.id ?? newEntryId(),
    ts: Date.now(),
    kind: opts.kind ?? "user",
    payload: { sum: opts.sum, body: opts.body, iid: "test" },
  };
}

function cacheEntry(parentId: string, content: string): Entry {
  return {
    id: newEntryId(),
    parentId,
    ts: Date.now(),
    kind: "recall-cache",
    payload: { fullMessage: { role: "user", content } },
  };
}

describe("recallBrowse", () => {
  test("empty store returns 'no history'", async () => {
    const store = new InMemoryStore();
    const out = await recallBrowse(store);
    assert.equal(out, "No conversation history.");
  });

  test("lists summary entries with id and sum", async () => {
    const store = new InMemoryStore();
    const e1 = summaryEntry({ sum: "user: hi" });
    const e2 = summaryEntry({ sum: "agent: hello", kind: "agent" });
    await store.append([e1, e2]);

    const out = await recallBrowse(store);
    assert.ok(out.includes("Recent summary"));
    assert.ok(out.includes(`#${e1.id}`));
    assert.ok(out.includes(`#${e2.id}`));
    assert.ok(out.includes("user: hi"));
    assert.ok(out.includes("agent: hello"));
  });

  test("filters out recall-cache entries", async () => {
    const store = new InMemoryStore();
    const e = summaryEntry({ sum: "user: hi" });
    await store.append([e]);
    await store.append([cacheEntry(e.id, "full content")], { ephemeral: true });

    const out = await recallBrowse(store);
    assert.ok(out.includes(`#${e.id}`));
    assert.ok(!out.includes("recall-cache"));
  });
});

describe("recallExpand", () => {
  test("missing id returns not-found", async () => {
    const store = new InMemoryStore();
    const out = await recallExpand(store, "missing");
    assert.ok(out.includes("not found"));
  });

  test("returns body when no cache is present", async () => {
    const store = new InMemoryStore();
    const e = summaryEntry({ sum: "user: hi", body: "full body text" });
    await store.append([e]);

    const out = await recallExpand(store, e.id);
    assert.ok(out.includes("full body text"));
    assert.ok(out.includes(`#${e.id}`));
  });

  test("returns recall-cache full content when present", async () => {
    const store = new InMemoryStore();
    const e = summaryEntry({ sum: "user: hi", body: "capped body" });
    await store.append([e]);
    await store.append([cacheEntry(e.id, "verbatim full message")], { ephemeral: true });

    const out = await recallExpand(store, e.id);
    assert.ok(out.includes("verbatim full message"));
    assert.ok(!out.includes("capped body"), "cache should take precedence over body");
  });

  test("recall-cache entries are not directly expandable", async () => {
    const store = new InMemoryStore();
    const cache = cacheEntry("anyparent", "stuff");
    await store.append([cache]);

    const out = await recallExpand(store, cache.id);
    assert.ok(out.includes("not expandable"));
  });
});

describe("recallSearch", () => {
  test("empty query returns prompt", async () => {
    const store = new InMemoryStore();
    const out = await recallSearch(store, "");
    assert.ok(out.includes("No query provided"));
  });

  test("no matches returns explanatory string", async () => {
    const store = new InMemoryStore();
    await store.append([summaryEntry({ sum: "user: hello" })]);
    const out = await recallSearch(store, "xyzzy");
    assert.ok(out.includes("No results"));
  });

  test("finds matches and counts them", async () => {
    const store = new InMemoryStore();
    await store.append([
      summaryEntry({ sum: "user: blue widget" }),
      summaryEntry({ sum: "user: red widget" }),
      summaryEntry({ sum: "agent: tool ran" }),
    ]);

    const hits = await recallSearch(store, "widget");
    assert.ok(hits.includes("Found 2 matches"));
  });

  test("excerpt comes from recall-cache when available", async () => {
    const store = new InMemoryStore();
    const e = summaryEntry({ sum: "user: question", body: "short body" });
    await store.append([e]);
    await store.append([cacheEntry(e.id, "the verbatim content mentions needle")], { ephemeral: true });

    const out = await recallSearch(store, "needle");
    assert.ok(out.includes("needle"));
    assert.ok(out.includes(`#${e.id}`));
  });

  test("falls back to summary body when no cache", async () => {
    const store = new InMemoryStore();
    const e = summaryEntry({ sum: "user: question", body: "body text with needle" });
    await store.append([e]);

    const out = await recallSearch(store, "needle");
    assert.ok(out.includes("needle"));
  });
});
