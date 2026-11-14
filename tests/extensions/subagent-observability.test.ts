/** What a run leaves behind for reading it afterwards, and the two things a workflow's agents kept getting wrong:
 *  their shell environment and the shape of their answers. */
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { coerce, validate, normalizeSchema } from "../../examples/extensions/subagents/schema.js";
import { body, setup } from "./subagents-harness.js";

const call = (name: string, args: unknown) => ({ tool_calls: [{ index: 0, id: name, function: { name, arguments: JSON.stringify(args) } }] });
const wf = (s: ReturnType<typeof setup>, name: string, src: string) => writeFileSync(join(s.root, "workflows", name), src);
const findFiles = (dir: string, name: string): string[] => existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap(e =>
  e.isDirectory() ? findFiles(join(dir, e.name), name) : e.name === name ? [join(dir, e.name)] : []) : [];
const lines = (file: string) => readFileSync(file, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l));

test("coerce repairs habitual slips and leaves real mismatches to validate", () => {
  const schema = normalizeSchema({ facts: "string[]", path: "string", count: "integer", done: "boolean", issues: [{ severity: "string", fix: "string?" }] });
  const fixed = coerce({ facts: "one fact", path: ["step 1", "step 2"], count: "3", done: "true", issues: { severity: "major" } }, schema);
  assert.deepEqual(fixed.value, { facts: ["one fact"], path: "step 1\nstep 2", count: 3, done: true, issues: [{ severity: "major" }] });
  assert.equal(validate(fixed.value, schema), null);
  assert.equal(fixed.notes.length, 5);
  assert.deepEqual(coerce({ facts: '["a", "b"]' }, normalizeSchema({ facts: "string[]" })).value, { facts: ["a", "b"] });
  // nothing to repair: unchanged, no notes
  const good = { facts: ["a"], path: "p", count: 1, done: false, issues: [] };
  assert.deepEqual(coerce(good, schema), { value: good, notes: [] });
  // a missing field and a wrong kind of item are not invented or guessed
  assert.match(String(validate(coerce({ issues: [{ fix: "x" }] }, normalizeSchema({ issues: [{ severity: "string" }] })).value, normalizeSchema({ issues: [{ severity: "string" }] }))), /severity is required/);
  assert.match(String(validate(coerce({ count: "many" }, normalizeSchema({ count: "integer" })).value, normalizeSchema({ count: "integer" }))), /must be integer/);
});

test("submit_result accepts a repaired answer, and a refused one is told the shape", async () => {
  let turn = 0;
  const seen: string[] = [];
  const s = setup({ reply: (o) => {
    seen.push(String(o.messages[o.messages.length - 1]!.content));
    turn++;
    return turn === 1 ? call("submit_result", { facts: "only one", issues: [{ fix: "x" }] })      // a missing required field
      : call("submit_result", { facts: "only one", issues: { severity: "major" } });              // repairable
  } });
  try {
    wf(s, "shape.ts", 'export default async ({ run }) => JSON.stringify(await run(null, "report", { returns: { facts: "string[]", issues: [{ severity: "string", fix: "string?" }] } }));');
    const r = await s.exec("run_workflow", { name: "shape" });
    assert.deepEqual(JSON.parse(body(r)), { facts: ["only one"], issues: [{ severity: "major" }] });
    assert.match(seen[1]!, /severity is required.*must have this shape.*"facts":\["<facts>"\]/s);
  } finally { s.cleanup(); }
});

