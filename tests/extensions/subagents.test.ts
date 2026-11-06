/** subagents extension: agent overrides, parallel fan-out, progress, adviseTool routing. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseAgent } from "../../examples/extensions/subagents/agents.js";
import { lastUser, setup } from "./subagents-harness.js";

test("parseAgent reads frontmatter and maps pi tool names", () => {
  const def = parseAgent("---\nname: x\ndescription: d\ntools: read, find, bash\nmaxIterations: 7\ninheritContext: true\n---\nPrompt body\n", "/a/x.md");
  assert.deepEqual(def && { ...def, source: undefined }, {
    name: "x", description: "d", systemPrompt: "Prompt body",
    tools: ["read_file", "glob", "bash"], model: undefined, thinking: undefined,
    maxIterations: 7, inheritContext: true, source: undefined,
  });
  assert.equal(parseAgent("no frontmatter", "/a/y.md"), null);
  assert.deepEqual(parseAgent("---\ntools: none\n---\nP", "/a/z.md")?.tools, []);
  assert.equal(parseAgent("---\ndescription: d\n---\nP", "/a/z.md")?.tools, undefined);
});

test("project agents override bundled ones and are advertised", async () => {
  const s = setup({ reply: () => ({ content: "ok" }) });
  try {
    writeFileSync(join(s.project, ".agent-sh", "agents", "scout.md"),
      "---\ndescription: project scout\ntools: grep\n---\nPROJECT SCOUT PROMPT");
    assert.match(s.description(), /- scout: project scout/);
    assert.match(s.description(), /- reviewer: /);

    await s.run({ agent: "scout", task: "find it" });
    assert.match(s.calls[0]!.messages[0]!.content, /PROJECT SCOUT PROMPT/);
    assert.deepEqual(s.calls[0]!.tools!.map(t => t.function.name), ["grep"]);
  } finally { s.cleanup(); }
});

test("extensions register agents by advising, before or after the extension loads; local files still win", async () => {
  const s = setup({
    reply: () => ({ content: "ok" }),
    before: (h) => h.advise("subagents:agents", (next) => [...next(), { name: "early", description: "registered early", prompt: "EARLY PROMPT", tools: ["grep"] }]),
  });
  try {
    const file = join(s.root, "late.md");
    writeFileSync(file, "---\nname: late\ndescription: registered late\n---\nLATE PROMPT");
    s.h.advise("subagents:agents", (next) => [...next(), file, { name: "reviewer", description: "ext reviewer", prompt: "EXT" }]);
    writeFileSync(join(s.project, ".agent-sh", "agents", "reviewer.md"), "---\ndescription: project reviewer\n---\nPROJECT");
    assert.match(s.description(), /- early: registered early/);
    assert.match(s.description(), /- late: registered late/);
    assert.match(s.description(), /- reviewer: project reviewer/);

    await s.run({ agent: "early", task: "t" });
    assert.match(s.calls[0]!.messages[0]!.content, /EARLY PROMPT/);
    assert.deepEqual(s.calls[0]!.tools!.map(t => t.function.name), ["grep"]);
    await s.run({ agent: "late", task: "t" });
    assert.match(s.calls[1]!.messages[0]!.content, /LATE PROMPT/);
  } finally { s.cleanup(); }
});

test("scout still runs as explore", async () => {
  const s = setup({ reply: () => ({ content: "ok" }) });
  try {
    const r = await s.run({ agent: "scout", task: "t" });
    assert.notEqual(r.isError, true);
    assert.match(s.calls[0]!.messages[0]!.content, /You are an exploring subagent/);
  } finally { s.cleanup(); }
});

test("extensions register workflows by advising", async () => {
  const s = setup({ reply: () => ({ content: "ok" }) });
  try {
    const file = join(s.root, "hi.ts");
    writeFileSync(file, 'export const description = "Says hi";\nexport default async () => "hi";\n');
    s.h.advise("subagents:workflows", (next) => [...next(), { name: "hi", file }]);
    assert.match(s.description("run_workflow"), /- hi: Says hi/);
    assert.equal(String((await s.exec("run_workflow", { name: "hi" })).content).split("\n\n")[0], "hi");
  } finally { s.cleanup(); }
});

test("unknown agents are rejected before anything runs", async () => {
  const s = setup({ reply: () => ({ content: "ok" }) });
  try {
    const r = await s.run({ agent: "nope", task: "t" });
    assert.equal(r.isError, true);
    assert.match(String(r.content), /Unknown agent: nope/);
    assert.equal(s.calls.length, 0);
  } finally { s.cleanup(); }
});

test("parallel tasks return one section per task in order", async () => {
  const s = setup({ reply: (o) => ({ content: `answer to ${o.messages.at(-1)!.content}` }) });
  try {
    const r = await s.run({ tasks: [{ agent: "reviewer", task: "A" }, { task: "B", tools: ["grep"] }] });
    assert.equal(r.isError, false);
    assert.match(String(r.content), /^2 subagents: 2 done\.\n\n## \[1\] reviewer · s1\n\nanswer to A[\s\S]*## \[2\] ad-hoc · s2\n\nanswer to B/);
    assert.ok(s.calls.every(c => !c.tools?.some(t => t.function.name === "spawn_agent")));
  } finally { s.cleanup(); }
});

test("subagent tool calls go through adviseTool wrappers", async () => {
  let turn = 0;
  const s = setup({ reply: () => turn++ === 0
    ? { tool_calls: [{ index: 0, id: "c1", function: { name: "grep", arguments: "{}" } }] }
    : { content: "done" } });
  try {
    const seen: string[] = [];
    s.h.advise("tool:grep", async (next: (...a: unknown[]) => Promise<unknown>, ...a: unknown[]) => {
      seen.push("advised");
      return next(...a);
    });
    const r = await s.run({ task: "search", tools: ["grep"] });
    assert.equal(r.content, "done\n\n[subagent s1]");
    assert.deepEqual(seen, ["advised"]);
  } finally { s.cleanup(); }
});

test("streams one progress line per subagent step and a closing status", async () => {
  const s = setup({ reply: (o) => o.messages.some((m) => m.role === "tool")
    ? { content: "found" }
    : { tool_calls: [{ index: 0, id: "c1", function: { name: "grep", arguments: JSON.stringify({ pattern: lastUser(o) }) } }] } });
  try {
    let out = "";
    await s.run({ tasks: [{ task: "alpha", tools: ["grep"] }, { agent: "scout", task: "beta" }] }, (c) => { out += c; });
    const lines = out.trim().split("\n").sort();
    assert.deepEqual(lines, [
      "[1 ad-hoc] done",
      "[1 ad-hoc] grep: alpha",
      "[2 scout] done",
      "[2 scout] grep: beta",
    ]);
  } finally { s.cleanup(); }
});

test("reports a subagent that hits its step limit", async () => {
  const s = setup({ reply: () => ({ tool_calls: [{ index: 0, id: "c1", function: { name: "grep", arguments: "{}" } }] }) });
  try {
    writeFileSync(join(s.project, ".agent-sh", "agents", "looper.md"), "---\ntools: grep\nmaxIterations: 2\n---\nloop");
    let out = "";
    await s.run({ agent: "looper", task: "go" }, (c) => { out += c; });
    assert.match(out, /\[looper\] stopped: step limit reached\n$/);
  } finally { s.cleanup(); }
});

test("progress lines show paths relative to the working directory", async () => {
  let turn = 0;
  const s = setup({ reply: (o) => turn++ === 0
    ? { tool_calls: [{ index: 0, id: "c1", function: { name: "bash", arguments: JSON.stringify({ command: `cd ${s.project} && cat ${s.project}/src/a.ts` }) } }] }
    : { content: "done" } });
  try {
    let out = "";
    await s.run({ task: "look", tools: ["bash"] }, (c) => { out += c; });
    assert.match(out, /\[ad-hoc\] bash: cd \. && cat src\/a\.ts\n/);
  } finally { s.cleanup(); }
});

test("registers the authoring and usage skills, each backed by a real guide", () => {
  const s = setup({ reply: () => ({ content: "ok" }) });
  try {
    assert.deepEqual([...s.skills.keys()].sort(), ["using-subagents", "writing-python-workflows", "writing-workflows"]);
    assert.match(readFileSync(s.skills.get("writing-python-workflows")!, "utf8"), /^# Writing agent-sh workflows in Python/);
    assert.match(readFileSync(s.skills.get("using-subagents")!, "utf8"), /^# Using subagents and workflows/);
    assert.match(readFileSync(s.skills.get("writing-workflows")!, "utf8"), /^# Writing workflows/);
  } finally { s.cleanup(); }
});

test("resume continues a finished subagent's conversation with its agent and tools", async () => {
  const s = setup({ reply: (o) => ({ content: `turn ${o.messages.filter((m) => m.role === "user").length}: ${lastUser(o)}` }) });
  try {
    const first = await s.run({ agent: "reviewer", task: "review the diff" });
    assert.equal(first.content, "turn 1: review the diff\n\n[subagent s1]");
    const next = await s.run({ resume: "s1", task: "now check the tests" });
    assert.equal(next.content, "turn 2: now check the tests\n\n[subagent s1]", "same id, same conversation");
    const resent = s.calls.at(-1)!.messages.map((m) => `${m.role}:${m.content}`);
    assert.ok(resent.includes("user:review the diff") && resent.includes("assistant:turn 1: review the diff"), JSON.stringify(resent));
    assert.equal(s.calls.at(-1)!.messages[0]!.content, s.calls[0]!.messages[0]!.content, "keeps the reviewer's system prompt");
  } finally { s.cleanup(); }
});

test("resume without a task returns the full answer without running anything", async () => {
  const s = setup({ reply: () => ({ content: "the answer" }) });
  try {
    await s.run({ task: "q" });
    const before = s.calls.length;
    const r = await s.run({ resume: "s1" });
    assert.equal(r.content, "the answer\n\n[subagent s1]");
    assert.equal(s.calls.length, before);
  } finally { s.cleanup(); }
});

test("unknown resume ids and repeated parallel tasks are refused before anything runs", async () => {
  const s = setup({ reply: () => ({ content: "x" }) });
  try {
    const gone = await s.run({ resume: "s9", task: "more" });
    assert.equal(gone.isError, true);
    assert.match(String(gone.content), /Unknown subagent id: s9\. Resumable: \(none\)/);
    const dup = await s.run({ tasks: [{ agent: "reviewer", task: "A" }, { task: "B" }, { agent: "reviewer", task: "A" }] });
    assert.equal(dup.isError, true);
    assert.match(String(dup.content), /tasks\[2\] repeats tasks\[0\]/);
    assert.equal(s.calls.length, 0);
  } finally { s.cleanup(); }
});

test("large fan-outs clip each answer, keep its tail, and point at resume for the rest", async () => {
  const long = (tag: string) => `${tag}-start ${"x".repeat(12_000)} ${tag}-end`;
  const s = setup({ reply: (o) => ({ content: long(lastUser(o)) }) });
  try {
    const r = await s.run({ tasks: [{ task: "a" }, { task: "b" }, { task: "c" }] });
    const text = String(r.content);
    assert.ok(text.length < 30_000, `clipped to about the budget, got ${text.length}`);
    for (const [tag, id] of [["a", "s1"], ["b", "s2"], ["c", "s3"]]) {
      assert.ok(text.includes(`${tag}-start`) && text.includes(`${tag}-end`), `${tag}: head and tail kept`);
      assert.ok(text.includes(`spawn_agent { resume: "${id}" } shows the full answer`));
    }
    const full = await s.run({ resume: "s2" });
    assert.equal(full.content, `${long("b")}\n\n[subagent s2]`);
  } finally { s.cleanup(); }
});

test("a fan-out marks subagents that stopped early, and they can be resumed", async () => {
  const s = setup({ reply: (o) => lastUser(o) === "loop" || o.messages.some((m) => m.role === "tool" && lastUser(o) === "loop")
    ? { tool_calls: [{ index: 0, id: "c1", function: { name: "grep", arguments: "{}" } }] }
    : { content: `ok ${lastUser(o)}` } });
  try {
    writeFileSync(join(s.project, ".agent-sh", "agents", "looper.md"), "---\ntools: grep\nmaxIterations: 2\n---\nloop");
    const r = await s.run({ tasks: [{ agent: "looper", task: "loop" }, { task: "fine" }] });
    const text = String(r.content);
    assert.match(text, /^2 subagents: 1 done, 1 stopped early\./);
    assert.match(text, /## \[1\] looper · s1 \(stopped: step limit\)/);
    const more = await s.run({ resume: "s1", task: "wrap up" });
    assert.equal(more.content, "ok wrap up\n\n[subagent s1]");
  } finally { s.cleanup(); }
});

test("subagent thinking uses the model's declared levels and its provider's reasoning hook", async () => {
  const s = setup({
    reply: () => ({ content: "ok" }),
    before: (h) => {
      h.define("agent:get-models", () => [{ id: "stub", provider: "deep", reasoningLevels: ["off", "high", "max"] }]);
      h.define("agent:resolve-endpoint", () => ({ buildReasoningParams: (l: string) => ({ thinking: { type: "enabled" }, reasoning_effort: l }) }));
    },
  });
  try {
    writeFileSync(join(s.project, ".agent-sh", "agents", "thinker.md"), "---\nthinking: xhigh\n---\nthink");
    await s.run({ agent: "thinker", task: "go" });
    const sent = s.calls[0] as unknown as Record<string, unknown>;
    assert.equal(sent.reasoning_effort, "max", "xhigh maps to the nearest declared level, not high");
    assert.deepEqual(sent.thinking, { type: "enabled" });
  } finally { s.cleanup(); }
});
