/** `agent-sh run <file>` end to end: the built CLI against a local fake OpenAI-compatible server. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fakeLlm, runCli, SUBAGENTS, toolCall, type ChatRequest } from "./fake-llm.js";
import { parseRunArgs } from "../../src/cli/run.js";

const TEMPLATE = fileURLToPath(new URL("../../examples/workflows/campaign.ts", import.meta.url));
const isSubagent = (req: ChatRequest) => String(req.messages[0]?.content ?? "").includes("focused subagent");
const write = (home: string, rel: string, text: string) => {
  mkdirSync(join(home, rel, ".."), { recursive: true });
  writeFileSync(join(home, rel), text);
};

test("runs a workflow file directly, with no main-agent turn", async () => {
  const llm = await fakeLlm((req) => ({ content: isSubagent(req) ? "found it" : "MAIN AGENT" }));
  try {
    const r = await runCli(["run", "campaign.ts", "src", "cli", "-e", SUBAGENTS], llm.url, {
      prepare: (home) => write(home, "campaign.ts", [
        'import type { WorkflowApi } from "agent-sh-subagents";',
        "export const config = { concurrency: 2 };",
        "export default async ({ run, args }: WorkflowApi): Promise<string> => {",
        '  const found: string = await run({ task: `scan ${args}`, tools: [] });',
        "  return `done: ${found}`;",
        "};",
      ].join("\n")),
    });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^done: found it\n\n\(workflow run \S+; log: .*workflow-runs/);
    assert.ok(llm.requests.length > 0 && llm.requests.every(isSubagent), "only subagents called the model");
    assert.match(r.stderr, /\[1 ad-hoc\] done/);
  } finally { llm.server.close(); }
});

test("config.agents adds agent definitions next to the file", async () => {
  const llm = await fakeLlm(() => ({ content: "ok" }));
  try {
    const r = await runCli(["run", "campaign.ts", "-e", SUBAGENTS], llm.url, {
      prepare: (home) => {
        write(home, "agents/custom.md", "---\nname: custom\ndescription: test agent\n---\nCUSTOM PROMPT");
        write(home, "campaign.ts", 'export const config = { agents: "./agents" };\nexport default async ({ run }) => run("custom", "go");\n');
      },
    });
    assert.equal(r.code, 0, r.stderr);
    assert.match(String(llm.requests[0]!.messages[0]!.content), /CUSTOM PROMPT/);
  } finally { llm.server.close(); }
});

test("refuses to start, before any model call, on a config key nothing handles", async () => {
  const llm = await fakeLlm(() => ({ content: "ok" }));
  try {
    const r = await runCli(["run", "campaign.ts", "-e", SUBAGENTS], llm.url, {
      prepare: (home) => write(home, "campaign.ts", 'export const config = { budgetToken: 5, hours: 1 };\nexport default async ({ run }) => run({ task: "t", tools: [] });\n'),
    });
    assert.equal(r.code, 2, r.stderr);
    assert.match(r.stderr, /config\.budgetToken is set but nothing handles it/);
    assert.equal(llm.requests.length, 0);
  } finally { llm.server.close(); }
});

test("an extension owns its config section: it claims the key and can refuse the run", async () => {
  const llm = await fakeLlm(() => ({ content: "ok" }));
  const quota = [
    "export default (ctx) => {",
    '  const { quota } = ctx.call("run:config");',
    '  ctx.bus.onPipe("run:checks", (p) => ({ ...p, handled: [...p.handled, "quota"],',
    '    problems: quota.max > 1 ? [...p.problems, "config.quota.max is over the limit"] : p.problems }));',
    "};",
  ].join("\n");
  const campaign = (max: number) => `export const config = { quota: { max: ${max} } };\nexport default async ({ run }) => run({ task: "t", tools: [] });\n`;
  try {
    const prepare = (max: number) => (home: string) => { write(home, "quota.mjs", quota); write(home, "campaign.ts", campaign(max)); };
    const ok = await runCli(["run", "campaign.ts", "-e", SUBAGENTS, "-e", "./quota.mjs"], llm.url, { prepare: prepare(1) });
    assert.equal(ok.code, 0, ok.stderr);
    const calls = llm.requests.length;
    const refused = await runCli(["run", "campaign.ts", "-e", SUBAGENTS, "-e", "./quota.mjs"], llm.url, { prepare: prepare(5) });
    assert.equal(refused.code, 2, refused.stderr);
    assert.match(refused.stderr, /refusing to start:\n  - config\.quota\.max is over the limit/);
    assert.equal(llm.requests.length, calls);
  } finally { llm.server.close(); }
});

test("an extension can wrap the run; the CLI re-runs it inside the wrapper once", async () => {
  const llm = await fakeLlm(() => ({ content: "ok" }));
  try {
    const r = await runCli(["run", "campaign.ts", "-e", SUBAGENTS, "-e", "./wrap.mjs"], llm.url, {
      prepare: (home) => {
        write(home, "wrap.mjs", 'export default (ctx) => ctx.bus.onPipe("run:wrap", (p) => ({ ...p, argv: ["/usr/bin/env", "WRAP_MARK=inside", ...p.argv] }));\n');
        write(home, "campaign.ts", 'export default async () => process.env.WRAP_MARK ?? "outside";\n');
      },
    });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^inside\n/);
  } finally { llm.server.close(); }
});

test("config.hours stops a run that outlives its deadline", async () => {
  const llm = await fakeLlm(() => ({ hang: true }));
  try {
    const r = await runCli(["run", "campaign.ts", "-e", SUBAGENTS], llm.url, {
      prepare: (home) => write(home, "campaign.ts", 'export const config = { hours: 0.0005 };\nexport default async ({ run }) => run({ task: "slow", tools: [] });\n'),
    });
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stderr, /deadline of 0\.0005 h reached/);
  } finally { llm.server.close(); }
});

test("a file without a default export is rejected", async () => {
  const llm = await fakeLlm(() => ({ content: "ok" }));
  try {
    const r = await runCli(["run", "campaign.ts", "-e", SUBAGENTS], llm.url, {
      prepare: (home) => write(home, "campaign.ts", "export const config = {};\n"),
    });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /must export a default function/);
  } finally { llm.server.close(); }
});

test("--resume continues a failed run, reusing what finished", async () => {
  let failSecond = true;
  const llm = await fakeLlm((req) => {
    const task = String(req.messages.at(-1)?.content ?? "");
    if (task === "second" && failSecond) return { status: 400 };
    return { content: `did ${task}` };
  });
  try {
    let home = "";
    const prepare = (h: string) => {
      home = h;
      write(h, "campaign.ts", 'export default async ({ run }) => [await run({ task: "first", tools: [] }), await run({ task: "second", tools: [] })].join(", ");\n');
    };
    const first = await runCli(["run", "campaign.ts", "-e", SUBAGENTS], llm.url, { prepare, keepHome: true });
    assert.equal(first.code, 1, first.stderr);
    const id = first.stdout.match(/\(workflow run (\S+);/)![1]!;
    assert.match(first.stdout, new RegExp(`agent-sh run .*campaign\\.ts --resume ${id}`));

    failSecond = false;
    const before = llm.requests.length;
    const second = await runCli(["run", "campaign.ts", "--resume", id, "-e", SUBAGENTS], llm.url, { home, keepHome: true });
    assert.equal(second.code, 0, second.stderr);
    assert.match(second.stdout, /^did first, did second/);
    assert.match(second.stderr, new RegExp(`\\[1 ad-hoc\\] reused from ${id}`));
    assert.equal(llm.requests.length - before, 1);
    assert.ok(readdirSync(join(home, ".agent-sh", "workflow-runs")).length === 2);

    const newest = second.stdout.match(/\(workflow run (\S+);/)![1]!;
    const status = await runCli(["run", "--status", "-e", SUBAGENTS], llm.url, { home, keepHome: true });
    assert.match(status.stdout, new RegExp(`^${newest}  campaign  done, \\d+s, \\d+ tokens\n  # 2  done +\\d+s  second`, "m"));
    const old = await runCli(["run", "--status", id, "-e", SUBAGENTS], llm.url, { home, keepHome: true });
    assert.match(old.stdout, /campaign  failed[\s\S]*# 1  done[\s\S]*# 2  failed/);
    rmSync(home, { recursive: true, force: true });
  } finally { llm.server.close(); }
});

test("the campaign template runs end to end", async () => {
  const submit = (args: unknown) => toolCall("submit_result", args);
  let planned = 0;
  const llm = await fakeLlm((req) => {
    const typed = req.tools?.some((t) => t.function.name === "submit_result");
    if (typed) return submit(planned++ === 0 ? { done: false, tasks: ["task A", "task B"] } : { done: true, tasks: [] });
    return { content: `result of ${String(req.messages.at(-1)?.content).split("\n")[0]}` };
  });
  try {
    const r = await runCli(["run", "campaign.ts", "the target", "-e", SUBAGENTS], llm.url, {
      prepare: (home) => write(home, "campaign.ts", readFileSync(TEMPLATE, "utf8")),
    });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^Done after 1 round\(s\)\.\n\n## Round 1\nresult of task A\n---\nresult of task B/);
    assert.match(r.stderr, /· round 1: 2\/2 tasks finished/);
  } finally { llm.server.close(); }
});

const PARAMS = [
  'export const description = "Shows its arguments.";',
  'export const args = { target: { default: "src", help: "what to review" }, rounds: 2 };',
  "export default async ({ args }) => JSON.stringify(args);",
].join("\n");

test("declared args come from --flags and positional words; a bad flag refuses with the help text", async () => {
  const llm = await fakeLlm(() => ({ content: "ok" }));
  try {
    const prepare = (h: string) => write(h, "params.ts", PARAMS);
    const ok = await runCli(["run", "params.ts", "lib/cli", "--rounds", "5", "-e", SUBAGENTS], llm.url, { prepare });
    assert.equal(ok.code, 0, ok.stderr);
    assert.match(ok.stdout, /^\{"target":"lib\/cli","rounds":5\}/);

    const bad = await runCli(["run", "params.ts", "--round", "5", "-e", SUBAGENTS], llm.url, { prepare });
    assert.equal(bad.code, 2);
    assert.match(bad.stderr, /unknown argument --round[\s\S]*Usage: agent-sh run params\.ts \[--target <text>\] \[--rounds <number>\]/);
  } finally { llm.server.close(); }
});

test("--help prints the file's arguments without calling a model", async () => {
  const llm = await fakeLlm(() => ({ content: "ok" }));
  try {
    const r = await runCli(["run", "params.ts", "--help", "-e", SUBAGENTS], llm.url, { prepare: (h) => write(h, "params.ts", PARAMS) });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^Usage: agent-sh run params\.ts \[--target <text>\] \[--rounds <number>\]\n\nShows its arguments\.\n\nArguments:\n  --target <text>\s+what to review; default: "src"\n  --rounds <number>\s+default: 2/);
    assert.equal(llm.requests.length, 0);
  } finally { llm.server.close(); }
});

test("--dry-run walks the script with placeholder answers and no model calls", async () => {
  const llm = await fakeLlm(() => ({ content: "ok" }));
  try {
    const r = await runCli(["run", "campaign.ts", "--dry-run", "-e", SUBAGENTS], llm.url, {
      prepare: (h) => write(h, "campaign.ts", [
        'export const config = { budgetToken: 5 };',
        "export default async ({ run, map }) => {",
        '  const plan = await run("scout", "Plan the work", { returns: { tasks: "string[]", done: "boolean" } });',
        '  const out = await map(plan.tasks, (t) => run("reviewer", `Do ${t}`));',
        "  return JSON.stringify({ plan, out });",
        "};",
      ].join("\n")),
    });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(llm.requests.length, 0);
    assert.match(r.stderr, /\(dry run\) a real run would refuse to start:\n  - config\.budgetToken is set but nothing handles it/);
    assert.match(r.stderr, /\[1 scout\] \(dry run\) Plan the work → \{"tasks":\["<tasks>"\],"done":false\}/);
    assert.match(r.stderr, /\[2 reviewer\] \(dry run\) Do <tasks>/);
    assert.match(r.stdout, /"out":\["\[dry run: reviewer would answer \\"Do <tasks>\\"\]"\]/);
  } finally { llm.server.close(); }
});

test("--dry-run reports an unknown agent", async () => {
  const llm = await fakeLlm(() => ({ content: "ok" }));
  try {
    const r = await runCli(["run", "campaign.ts", "--dry-run", "-e", SUBAGENTS], llm.url, {
      prepare: (h) => write(h, "campaign.ts", 'export default async ({ run }) => run("nosuchagent", "go");\n'),
    });
    assert.equal(r.code, 1);
    assert.match(r.stdout, /unknown agent: nosuchagent/);
  } finally { llm.server.close(); }
});

test("run arguments: --status takes an optional run id and needs no file", () => {
  assert.deepEqual(parseRunArgs(["--status"])?.status, "");
  assert.deepEqual(parseRunArgs(["--status", "20261003-002912-9397"])?.status, "20261003-002912-9397");
  assert.equal(parseRunArgs(["--status", "f.ts"])?.file, "f.ts");
  assert.equal(parseRunArgs(["f.ts"])?.status, undefined);
  assert.equal(parseRunArgs([]), null);
});
