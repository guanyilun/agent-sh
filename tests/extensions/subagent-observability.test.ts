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

test("env runs before each of an agent's shell commands; the transcript keeps the agent's own text", async () => {
  let turn = 0;
  const s = setup({ reply: () => (++turn === 1 ? call("bash", { command: "python fit.py" }) : { content: "done" }) });
  const ran: string[] = [];
  s.h.advise("tool:bash", (_next: unknown, args: { command: string }) => { ran.push(args.command); return { content: "ok", exitCode: 0, isError: false }; });
  try {
    wf(s, "envy.ts", 'export default async ({ run }) => run(null, "fit", { tools: ["bash"], env: "source env.sh >/dev/null 2>&1; umask 077", label: "fitter", model: "m1" });');
    await s.exec("run_workflow", { name: "envy" });
    assert.deepEqual(ran, ["source env.sh >/dev/null 2>&1; umask 077\npython fit.py"]);
    const transcript = lines(findFiles(s.root, "1.jsonl")[0]!);
    const start = transcript.find(e => e.type === "start")!;
    assert.equal(start.label, "fitter");
    assert.equal(start.model, "m1");
    assert.equal(start.id, "1");
    assert.ok(JSON.stringify(transcript).includes("python fit.py") && !JSON.stringify(transcript.filter(e => e.type === "message")).includes("umask"));
    const request = transcript.find(e => e.type === "request");
    if (request) assert.equal(request.model, "m1");
  } finally { s.cleanup(); }
});

test("event() from a workflow lands in the run's events.jsonl", { skip: spawnSync("python3", ["--version"]).status !== 0 }, async () => {
  const s = setup({ reply: () => ({ content: "fine" }) });
  try {
    wf(s, "ev.py", [
      "from agentsh import run, event",
      "async def main():",
      '    answer = await run("check", tools=[])',
      '    event("check", worker="w1", ok=True, round=1)',
      "    return answer",
    ].join("\n"));
    await s.exec("run_workflow", { name: "ev" });
    wf(s, "ev2.ts", 'export default async ({ event }) => { event("promotion", { id: "g1w0", gain: 0.2 }); return "x"; };');
    await s.exec("run_workflow", { name: "ev2" });
    const all = findFiles(s.root, "events.jsonl").flatMap(lines);
    assert.ok(all.some(e => e.kind === "check" && e.worker === "w1" && e.ok === true && e.round === 1 && typeof e.at === "number"));
    assert.ok(all.some(e => e.kind === "promotion" && e.gain === 0.2));
  } finally { s.cleanup(); }
});

