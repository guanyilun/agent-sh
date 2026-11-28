import test from "node:test";
import assert from "node:assert/strict";
import { shortenPaths, clipDetail } from "../../examples/extensions/subagents/describe.ts";

test("progress lines keep a command's arguments: long paths shortened, long lines cut in the middle (2026-11-28)", () => {
  const cmd = "python3 /home/u/.claude/skills/agent-teams/kb.py --kb /home/u/work/projects/riemann/out/agent-sh/kbpilot/kb search valuation \"R(120,0)\"";
  assert.equal(shortenPaths(cmd), "python3 …/agent-teams/kb.py --kb …/kbpilot/kb search valuation \"R(120,0)\"");
  assert.equal(shortenPaths("cat /etc/hosts ./a/b/c/d.txt"), "cat /etc/hosts ./a/b/c/d.txt");
  const long = "x".repeat(100) + " END";
  const clipped = clipDetail(long);
  assert.equal(clipped.length, 160 > long.length ? long.length : 160);
  assert.ok(clipDetail("a".repeat(200) + " LAST").endsWith(" LAST"));
});
