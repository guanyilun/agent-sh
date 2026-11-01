/** Per-agent write roots: one subagent's writes are limited to its own paths (a tripwire inside the run's sandbox). */
import test from "node:test";
import assert from "node:assert/strict";
import { writeRootsVerdict, writtenPaths } from "../../examples/extensions/subagents/write-roots.js";

const cwd = "/job";
const v = writeRootsVerdict(["work/lanes/A"], cwd);

test("file tools: inside the roots allowed, outside refused", () => {
  assert.equal(v("write_file", { path: "/job/work/lanes/A/src/x.py" }), null);
  assert.equal(v("edit_file", { path: "work/lanes/A/x.py" }), null);
  assert.ok(v("write_file", { path: "/job/work/repo/src/x.py" }));
  assert.ok(v("edit_file", { path: "/job/work/lanes/AB/x.py" }), "a sibling with the same prefix is outside");
});

test("bash: redirections, tee, cp/mv targets, rm, sed -i; cd is followed", () => {
  assert.equal(v("bash", { command: "cd work/lanes/A && python3 run.py > out/log.txt 2>&1" }), null);
  assert.ok(v("bash", { command: "python3 run.py > /job/work/repo/log.txt" }));
  assert.ok(v("bash", { command: "echo x | tee /tmp/j.txt" }));
  assert.ok(v("bash", { command: "cp a.txt /job/work/repo/a.txt" }));
  assert.ok(v("bash", { command: "rm -rf /job/work/repo/out" }));
  assert.ok(v("bash", { command: "sed -i 's/a/b/' /job/work/repo/f.py" }));
  assert.equal(v("bash", { command: "ls /job/work/repo && git -C /job/work/repo diff --stat" }), null, "reading is fine");
  assert.equal(v("bash", { command: "python3 run.py 2>/dev/null" }), null);
});

test("code given to interpreters is not mistaken for shell", () => {
  assert.equal(v("bash", { command: `python3 -c "print(1 > 0)"` }), null);
  assert.equal(v("bash", { command: "python3 - <<'EOF'\nif a > b:\n    print(a)\nEOF" }), null);
  assert.deepEqual(writtenPaths("cd /x && echo hi > 'out.txt'", "/c"), ["/x/out.txt"]);
});

test("an empty list makes the agent read-only", () => {
  const ro = writeRootsVerdict([], cwd);
  assert.ok(ro("write_file", { path: "/job/x" }));
  assert.ok(ro("bash", { command: "echo > /job/scratch.txt" }));
  assert.equal(ro("bash", { command: "grep -n foo /job/a.py" }), null);
});
