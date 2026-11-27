/** The per-command agent box (sandbox/agents.ts) and the guard's reveal list. */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { makeVerdict } from "../../examples/extensions/sandbox/guard.js";
import { defaultAgentHides, probeNested, wrapCommand } from "../../examples/extensions/sandbox/agents.js";

test("guard: a revealed path under a hidden one stays readable; the rest stays hidden", () => {
  const v = makeVerdict({ hide: ["/h/.claude"], reveal: ["/h/.claude/skills"] });
  assert.equal(v("read_file", { path: "/h/.claude/skills/x/team.py" }), null);
  assert.ok(v("read_file", { path: "/h/.claude/.credentials.json" }));
  assert.equal(v("bash", { command: "python3 /h/.claude/skills/x/lean_judge.py a b" }), null);
  assert.ok(v("bash", { command: "cat /h/.claude/history.jsonl" }));
  assert.ok(v("bash", { command: "ls /h/.claude/skills; cat /h/.claude/settings.json" }));
});

test("default agent hides: credentials and agent-sh homes, with skills revealed", () => {
  const home = mkdtempSync(join(tmpdir(), "home-"));
  try {
    for (const d of [".ssh", ".codex", ".agent-sh", ".claude/skills"]) mkdirSync(join(home, d), { recursive: true });
    writeFileSync(join(home, ".netrc"), "x");
    const { hide, reveal } = defaultAgentHides(join(home, ".agent-sh"), home);
    for (const p of [".ssh", ".codex", ".agent-sh", ".claude", ".netrc"]) assert.ok(hide.includes(join(home, p)), p);
    assert.ok(!hide.includes(join(home, ".aws")), "only paths that exist");
    assert.deepEqual(reveal, [join(home, ".claude", "skills")]);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

const bwrap = process.env.SBX_BWRAP || "/usr/bin/bwrap";
test("the box under bubblewrap: hidden unreadable, revealed readable, writes only in write roots, net off", { skip: !existsSync(bwrap) || !probeNested(bwrap) }, () => {
  const base = mkdtempSync(join(homedir(), ".box-test-"));      // not under /tmp, which the box keeps writable
  try {
    const secret = join(base, "secret"), claude = join(base, "claude"), work = join(base, "work"), state = join(base, "state");
    for (const d of [secret, join(claude, "skills"), work, state]) mkdirSync(d, { recursive: true });
    writeFileSync(join(secret, "keys.json"), "k"); writeFileSync(join(claude, "history"), "h"); writeFileSync(join(claude, "skills", "team.py"), "t");
    const box = { write: [work], net: false, hide: [secret, claude], reveal: [join(claude, "skills")] };
    const run = (cmd: string) => spawnSync("bash", ["-c", wrapCommand(bwrap, box, base, cmd)], { encoding: "utf8" });
    assert.equal(run(`test -r ${secret}/keys.json && [ -s ${secret}/keys.json ]`).status, 1, "hidden file readable");
    assert.equal(run(`cat ${claude}/history`).status, 1, "hidden dir readable");
    assert.equal(run(`cat ${claude}/skills/team.py`).stdout, "t", "revealed path unreadable");
    assert.equal(run(`echo w > ${work}/f && cat ${work}/f`).stdout.trim(), "w", "write root not writable");
    assert.notEqual(run(`echo w > ${state}/f`).status, 0, "state writable");
    assert.notEqual(run(`python3 -c "import socket; socket.create_connection(('1.1.1.1', 53), 3)"`).status, 0, "network reachable");
    assert.equal(run(`echo 'it''s quoted'; exit 3`).status, 3, "exit status and quoting");
  } finally { rmSync(base, { recursive: true, force: true }); }
});
