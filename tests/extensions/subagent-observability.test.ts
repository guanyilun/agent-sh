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

test("steer reaches a working agent once and is logged; a later run continues the conversation", async () => {
  const requests: string[][] = [];
  let turn = 0;
  const s = setup({ reply: (o) => {
    requests.push(o.messages.map(m => `${m.role}: ${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`));
    turn++;
    return turn === 1 ? call("bash", { command: "make maps" }) : { content: `answer ${turn}` };
  } });
  try {
    wf(s, "first.ts", [
      "export default async ({ agent, runId }) => {",
      '  const worker = agent(null, { tools: ["bash"], label: "mapper" });',
      '  const answer = worker.ask("make the f090 maps");',
      '  worker.steer("use 50 iterations, not 150");',
      "  await answer;",
      "  return JSON.stringify({ run: runId, conversation: worker.id });",
      "};",
    ].join("\n"));
    const first = JSON.parse(body(await s.exec("run_workflow", { name: "first" })));
    assert.ok(!requests[0]!.some(m => m.includes("50 iterations")), "not in the first request");
    assert.equal(requests[1]!.filter(m => m.startsWith("user:") && m.includes("50 iterations")).length, 1, "delivered after the tool round, once");
    const transcript = lines(findFiles(s.root, "1.jsonl")[0]!);
    assert.ok(transcript.some(e => e.type === "steer" && String(e.text).includes("50 iterations")), "the delivery is on record");
    assert.equal(transcript.find(e => e.type === "start")!.conversation, first.conversation);

    wf(s, "second.ts", [
      "export default async ({ agent, args }) => {",
      "  const [run, conversation] = String(args).split(' ');",
      '  return agent(null, { tools: ["bash"], historyFrom: { run, conversation } }).ask("you were interrupted; continue");',
      "};",
    ].join("\n"));
    const before = requests.length;
    await s.exec("run_workflow", { name: "second", args: `${first.run} ${first.conversation}` });
    const resumed = requests[before]!;
    assert.ok(resumed.some(m => m === "user: make the f090 maps"), "the earlier task");
    assert.ok(resumed.some(m => m.startsWith("tool:") && m.includes("bash ran")), "the earlier tool result");
    assert.ok(resumed.some(m => m.includes("50 iterations")), "the steering");
    assert.ok(resumed[resumed.length - 1]!.includes("you were interrupted; continue"), "then the new turn");
    // A third run continuing the second gets the first's steps too (a job restarted more than once).
    wf(s, "again.ts", [
      "export default async ({ agent, runId }) => {",
      '  const worker = agent(null, { tools: ["bash"], historyFrom: { run: "' + "${first.run}" + '", conversation: "' + "${first.conversation}" + '" } });',
      '  await worker.ask("second leg");',
      "  return JSON.stringify({ run: runId, conversation: worker.id });",
      "};",
    ].join("\n").replace("${first.run}", first.run).replace("${first.conversation}", first.conversation));
    const second = JSON.parse(body(await s.exec("run_workflow", { name: "again" })));
    const mark = requests.length;
    await s.exec("run_workflow", { name: "second", args: `${second.run} ${second.conversation}` });
    const chained = requests[mark]!;
    assert.ok(chained.some(m => m === "user: make the f090 maps") && chained.some(m => m === "user: second leg"), "both earlier legs");
    assert.ok(chained.findIndex(m => m === "user: make the f090 maps") < chained.findIndex(m => m === "user: second leg"), "in order");

    await assert.rejects(async () => {
      wf(s, "third.ts", 'export default async ({ agent }) => agent(null, { historyFrom: { run: "nope", conversation: "1" } }).ask("x");');
      const r = await s.exec("run_workflow", { name: "third" });
      if (/no conversation 1 in run nope/.test(String(r.content))) throw new Error("refused");
    }, /refused/);
  } finally { s.cleanup(); }
});

test("a transcript cut mid-step is rebuilt up to its last complete step", async () => {
  const { transcriptMessages } = await import("../../examples/extensions/subagents/runs.js");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "cut-"));
  try {
    const file = join(dir, "3.jsonl");
    writeFileSync(file, [
      { type: "start", task: "t", id: "2:1", conversation: "2" },
      { type: "message", role: "user", content: "t" },
      { type: "message", role: "assistant", content: "reading", toolCalls: [{ id: "a", name: "read_file", arguments: "{}" }] },
      { type: "message", role: "tool", toolName: "read_file", content: "data", callId: "a" },
      { type: "request", total_tokens: 5 },
      { type: "message", role: "assistant", content: "two more", toolCalls: [{ id: "b", name: "bash", arguments: "{}" }, { id: "c", name: "bash", arguments: "{}" }] },
      { type: "message", role: "tool", toolName: "bash", content: "one", callId: "b" },
    ].map(e => JSON.stringify(e)).join("\n"));
    const messages = transcriptMessages([file], "2");
    assert.deepEqual(messages.map(m => m.role), ["user", "assistant", "tool"]);
    assert.equal(messages[2]!.tool_call_id, "a");
    assert.deepEqual(transcriptMessages([file], "other"), []);
    // transcripts from before call ids were logged: results are matched in order
    writeFileSync(file, [
      { type: "start", task: "t" },
      { type: "message", role: "user", content: "t" },
      { type: "message", role: "assistant", content: "", toolCalls: [{ name: "bash", arguments: "{}" }] },
      { type: "message", role: "tool", toolName: "bash", content: "ok" },
      { type: "message", role: "assistant", content: "done" },
    ].map(e => JSON.stringify(e)).join("\n"));
    const old = transcriptMessages([file]);
    assert.equal(old.length, 4);
    assert.equal((old[1]!.tool_calls as { id: string }[])[0]!.id, old[2]!.tool_call_id);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
