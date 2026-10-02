/** The sandbox guard self-test and the bubblewrap probe. */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SELFTEST = fileURLToPath(new URL("../../examples/extensions/subagents/sandbox/guard_selftest.mjs", import.meta.url));
const SANDBOX = fileURLToPath(new URL("../../examples/extensions/subagents/sandbox/index.mjs", import.meta.url));
const LANDLOCK = fileURLToPath(new URL("../../examples/extensions/subagents/sandbox/landlock.py", import.meta.url));

test("guard self-test passes, including hidden paths", () => {
  const root = mkdtempSync(join(tmpdir(), "sbx-guard-"));
  try {
    const hidden = join(root, "heldout-data");
    writeFileSync(join(root, "placeholder"), "");
    const r = spawnSync(process.execPath, [SELFTEST], {
      env: { ...process.env, SBX_WRITE_ROOTS: join(root, "work"), SBX_HIDE: hidden },
      encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /guard selftest ok .*hidden paths included/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the bubblewrap probe rejects a bwrap that is installed but fails to run", async () => {
  const { probeBwrap } = await import(SANDBOX);
  const root = mkdtempSync(join(tmpdir(), "sbx-probe-"));
  try {
    const fake = (name: string, body: string) => { const f = join(root, name); writeFileSync(f, `#!/bin/sh\n${body}\n`); chmodSync(f, 0o755); return f; };
    assert.deepEqual(probeBwrap(fake("works", "exit 0")), { ok: true });
    const blocked = probeBwrap(fake("blocked", "echo 'bwrap: setting up uid map: Permission denied' >&2; exit 1"));
    assert.equal(blocked.ok, false);
    assert.match(blocked.reason, /setting up uid map: Permission denied/);
    assert.match(probeBwrap(join(root, "missing")).reason, /not found/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the Seatbelt profile allows writes only where the policy says, and hides hidden paths", async () => {
  const { seatbeltProfile } = await import(fileURLToPath(new URL("../../examples/extensions/subagents/sandbox/seatbelt.mjs", import.meta.url)));
  const p: string = seatbeltProfile({ write: ["/work/out", '/odd "dir"'], hide: ["/data/heldout"], home: "/h/.agent-sh" });
  assert.match(p, /^\(version 1\)\n\(allow default\)\n\(deny file-write\*\)\n/);
  assert.match(p, /\(allow file-write\* \(subpath "\/work\/out"\) \(subpath "\/odd \\"dir\\""\) \(subpath "\/h\/\.agent-sh"\)/);
  assert.match(p, /\(deny file-write\* \(subpath "\/h\/\.agent-sh\/settings\.json"\) \(subpath "\/h\/\.agent-sh\/keys\.json"\) \(subpath "\/h\/\.agent-sh\/extensions"\)/);
  assert.match(p, /\(deny file-read\* file-write\* \(subpath "\/data\/heldout"\)\)$/);
});

test("the Landlock plan allows writes where the policy says and reads everywhere except hidden paths", () => {
  const root = mkdtempSync(join(tmpdir(), "sbx-landlock-"));
  try {
    for (const d of ["a/b", "a/heldout", "work", "home/extensions", "home/workflow-runs"]) mkdirSync(join(root, d), { recursive: true });
    writeFileSync(join(root, "a", "notes.txt"), "x");
    writeFileSync(join(root, "home", "settings.json"), "{}");
    const r = spawnSync("python3", [LANDLOCK, "--plan", "--rw", join(root, "work"), "--home", join(root, "home"), "--hide", join(root, "a", "heldout")], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const real = (p: string) => realpathSync(p);
    // Landlock combines rules on the same path, so merge them the same way.
    const rules = new Map<string, number>();
    for (const [p, rights] of JSON.parse(r.stdout).rules as [string, number][]) rules.set(p, (rules.get(p) ?? 0) | rights);
    const WRITE_FILE = 2, READ_FILE = 4;
    assert.ok((rules.get(real(join(root, "work")))! & WRITE_FILE) !== 0, "write dir is writable");
    assert.ok((rules.get(real(join(root, "home", "workflow-runs")))! & WRITE_FILE) !== 0, "home runtime state is writable");
    assert.ok(!rules.has(real(join(root, "home", "extensions"))) && !rules.has(real(join(root, "home", "settings.json"))), "home config stays read-only");
    assert.equal(rules.get(real(join(root, "a", "b"))), READ_FILE | 8, "beside the hidden dir is readable");
    assert.equal(rules.get(real(join(root, "a", "notes.txt"))), READ_FILE | 8);
    assert.ok(![...rules.keys()].some((p) => p.startsWith(real(join(root, "a", "heldout")))), "the hidden dir gets no rule");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
