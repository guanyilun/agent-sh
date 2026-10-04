/** The sandbox extension's guard rules, OS sandbox probes and generated policies. */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { armGuard, makeVerdict } from "../../examples/extensions/sandbox/guard.js";
import { probeBwrap } from "../../examples/extensions/sandbox/index.js";
import { seatbeltProfile } from "../../examples/extensions/sandbox/seatbelt.js";

const LANDLOCK = fileURLToPath(new URL("../../examples/extensions/sandbox/landlock.py", import.meta.url));
const blocked = (r: { content: string } | null, why: RegExp) => assert.match(r?.content ?? "allowed", why);

test("built-in rules: writes stay under the write dirs, hidden paths can't be read, rm -r stays inside", () => {
  const v = makeVerdict({ write: ["/w/out"], hide: ["/w/secrets"] });
  blocked(v("write_file", { path: "/elsewhere/x.txt" }), /writes are limited to \/w\/out/);
  blocked(v("edit_file", { path: "/etc/passwd" }), /writes are limited to/);
  blocked(v("bash", { command: "rm -rf /elsewhere/dir" }), /rm -r outside the allowed write roots/);
  blocked(v("read_file", { path: "/w/secrets/key.json" }), /hidden from agents/);
  blocked(v("ls", { path: "/w/secrets" }), /hidden from agents/);
  blocked(v("grep", { pattern: "x", path: "/w/secrets" }), /hidden from agents/);
  blocked(v("bash", { command: "cat /w/secrets/key.json" }), /hidden from agents/);
  blocked(v("bash", { command: "cat /w/out/../secrets/key.json" }), /hidden from agents/);
  for (const [tool, args] of [
    ["write_file", { path: "/w/out/ok.txt" }],
    ["read_file", { path: "/w/out/ok.txt" }],
    ["bash", { command: "rm -r /w/out/tmp" }],
    ["bash", { command: "find . -name '*.py'" }],
    // Naming a hidden dir isn't reading it.
    ["bash", { command: "grep -n secrets src/config.ts" }],
    // No opinion on git or anything else unless a policy file adds one.
    ["bash", { command: "git commit -m wip" }],
  ] as const) assert.equal(v(tool, args), null, `${tool} ${JSON.stringify(args)}`);
});

test("a policy file adds forbidden commands and no-recursive-search paths; an unreadable one refuses everything", () => {
  const root = mkdtempSync(join(tmpdir(), "sbx-policy-"));
  try {
    const policy = join(root, "policy.json");
    writeFileSync(policy, JSON.stringify({
      forbid: [{ regex: "\\bgit\\s+(push|commit)\\b", message: "git history is the user's" }, { regex: "(^|\\s)curl\\s" }],
      noRecursiveSearch: { at: ["/srv/shared"], under: ["/opt/big"], message: "too big to search" },
    }));
    const v = makeVerdict({ write: [root], policy });
    blocked(v("bash", { command: "git commit -m wip" }), /git history is the user's/);
    blocked(v("bash", { command: "curl https://example.com/x" }), /matches forbidden pattern/);
    blocked(v("bash", { command: "find /srv/shared -name x" }), /too big to search/);
    blocked(v("bash", { command: "grep -r foo /opt/big/lib" }), /too big to search/);
    blocked(v("glob", { pattern: "**/*.py", path: "/srv/shared" }), /too big to search/);
    assert.equal(v("bash", { command: "git status" }), null);
    assert.equal(v("glob", { pattern: "*.json", path: root }), null);

    blocked(makeVerdict({ policy: join(root, "missing.json") })("read_file", { path: "/anything" }), /could not be read .*refusing everything/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the guard covers the main agent's tool calls and the per-tool handlers subagents use", async () => {
  const hooks = new Map<string, (next: (...a: any[]) => any, ...a: any[]) => any>();
  armGuard({ advise: (name, fn) => hooks.set(name, fn) }, makeVerdict({ write: ["/w/out"] }));
  const passed = { content: "ran" };
  const args = { path: "/elsewhere/x" };
  assert.match((await hooks.get("tool:execute")!(async () => passed, { name: "write_file", args })).content, /Blocked by sandbox guard/);
  assert.match((await hooks.get("tool:write_file")!(async () => passed, args)).content, /Blocked by sandbox guard/);
  assert.equal(await hooks.get("tool:read_file")!(async () => passed, args), passed);
});

test("the bubblewrap probe rejects a bwrap that is installed but fails to run", () => {
  const root = mkdtempSync(join(tmpdir(), "sbx-probe-"));
  try {
    const fake = (name: string, body: string) => { const f = join(root, name); writeFileSync(f, `#!/bin/sh\n${body}\n`); chmodSync(f, 0o755); return f; };
    assert.deepEqual(probeBwrap(fake("works", "exit 0")), { ok: true });
    const failed = probeBwrap(fake("blocked", "echo 'bwrap: setting up uid map: Permission denied' >&2; exit 1"));
    assert.equal(failed.ok, false);
    assert.match(failed.reason!, /setting up uid map: Permission denied/);
    assert.match(probeBwrap(join(root, "missing")).reason!, /not found/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the Seatbelt profile allows writes only where the policy says, and hides hidden paths", () => {
  const p = seatbeltProfile({ write: ["/work/out", '/odd "dir"'], hide: ["/data/private"], home: "/h/.agent-sh" });
  assert.match(p, /^\(version 1\)\n\(allow default\)\n\(deny file-write\*\)\n/);
  assert.match(p, /\(allow file-write\* \(subpath "\/work\/out"\) \(subpath "\/odd \\"dir\\""\) \(subpath "\/h\/\.agent-sh"\)/);
  assert.match(p, /\(deny file-write\* \(subpath "\/h\/\.agent-sh\/settings\.json"\) \(subpath "\/h\/\.agent-sh\/keys\.json"\) \(subpath "\/h\/\.agent-sh\/extensions"\)/);
  assert.match(p, /\(deny file-read\* file-write\* \(subpath "\/data\/private"\)\)$/);
});

test("the Landlock plan allows writes where the policy says and reads everywhere except hidden paths", () => {
  const root = mkdtempSync(join(tmpdir(), "sbx-landlock-"));
  try {
    for (const d of ["a/b", "a/private", "work", "home/extensions", "home/workflow-runs"]) mkdirSync(join(root, d), { recursive: true });
    writeFileSync(join(root, "a", "notes.txt"), "x");
    writeFileSync(join(root, "home", "settings.json"), "{}");
    const r = spawnSync("python3", ["-B", LANDLOCK, "--plan", "--rw", join(root, "work"), "--home", join(root, "home"), "--hide", join(root, "a", "private")], { encoding: "utf8" });
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
    assert.ok(![...rules.keys()].some((p) => p.startsWith(real(join(root, "a", "private")))), "the hidden dir gets no rule");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
