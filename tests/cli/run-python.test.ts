/** Python run files under `agent-sh run`: the built CLI against a local fake OpenAI-compatible server. */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fakeLlm, lastUser, runCli, SANDBOX, SUBAGENTS, toolCall, type ChatRequest } from "./fake-llm.js";

const skip = spawnSync("python3", ["--version"]).status !== 0;
const RUN = (file: string, ...rest: string[]) => ["run", file, ...rest, "-e", SUBAGENTS];
const write = (home: string, rel: string, lines: string[]) => {
  mkdirSync(join(home, rel, ".."), { recursive: true });
  writeFileSync(join(home, rel), lines.join("\n") + "\n");
};
const typed = (req: ChatRequest) => req.tools?.some((t) => t.function.name === "submit_result");
const runId = (stdout: string) => stdout.match(/\(workflow run (\S+);/)![1]!;

test("a Python file runs with typed returns, map, pipeline, declared args, log and print", { skip }, async () => {
  const llm = await fakeLlm((req) => {
    if (typed(req)) return toolCall("submit_result", { done: false, tasks: ["a", "boom", "c"] });
    if (lastUser(req) === "boom") return { status: 400 };
    return { content: lastUser(req).toUpperCase() };
  });
  try {
    const r = await runCli(RUN("campaign.py", "lib", "--rounds", "5"), llm.url, {
      prepare: (home) => write(home, "campaign.py", [
        "from dataclasses import dataclass",
        "from agentsh import log, map, pipeline, run",
        "",
        'description = "Shows the pieces."',
        'args = dict(target=dict(default="src", help="what to plan"), rounds=2)',
        "config = dict(concurrency=2)",
        "",
        "@dataclass",
        "class Plan:",
        "    done: bool",
        "    tasks: list[str]",
        "",
        "async def main(args):",
        '    plan = await run("explore", f"""',
        "        plan {args.target}",
        '    """, returns=Plan)',
        '    print("planned", len(plan.tasks))',
        '    log(f"rounds={args.rounds}")',
        "    out = await map(plan.tasks, lambda t: run(None, t, tools=[]))",
        '    piped = await pipeline(["x"], lambda prev, item: run(None, f"one {item}", tools=[]), lambda prev, item: run(None, f"two {prev}", tools=[]))',
        '    return {"done": plan.done, "out": out, "piped": piped}',
      ]),
    });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout.split("\n\n(workflow run ")[0]!), { done: false, out: ["A", null, "C"], piped: ["TWO ONE X"] });
    assert.match(lastUser(llm.requests[0]!), /^plan lib$/);
    assert.match(r.stderr, /· planned 3\n/);
    assert.match(r.stderr, /· rounds=5\n/);
    assert.match(r.stderr, /· map item 2 failed/);
  } finally { llm.server.close(); }
});

test("race in Python cancels the losers, and --resume reruns only the winner", { skip }, async () => {
  let failAfter = true;
  const llm = await fakeLlm((req) => {
    const task = lastUser(req);
    if (task === "try slow") return { hang: true };
    if (task === "after" && failAfter) return { status: 400 };
    return { content: `did ${task}` };
  });
  try {
    let home = "";
    const prepare = (h: string) => {
      home = h;
      write(h, "campaign.py", [
        "from agentsh import race, run",
        "",
        "async def attempt(x):",
        '    await run(None, f"try {x}", tools=[])',
        '    return await run(None, f"polish {x}", tools=[])',
        "",
        "async def main():",
        '    won = await race(["slow", "bad", "fast"], attempt, lambda v: "bad" not in v)',
        '    none = await race(["bad"], lambda x: run(None, f"try {x}", tools=[]), lambda v: False)',
        '    await run(None, "after", tools=[])',
        '    return {"won": list(won), "none": none}',
      ]);
    };
    const first = await runCli(RUN("campaign.py"), llm.url, { prepare, keepHome: true });
    assert.equal(first.code, 1, first.stderr);
    assert.match(first.stderr, /\[1 ad-hoc\] cancelled/);
    assert.ok(!llm.requests.some((q) => lastUser(q) === "polish slow"));
    const before = llm.requests.length;

    failAfter = false;
    const second = await runCli(RUN("campaign.py", "--resume", runId(first.stdout)), llm.url, { home });
    assert.equal(second.code, 0, second.stderr);
    assert.deepEqual(JSON.parse(second.stdout.split("\n\n(workflow run ")[0]!), { won: ["did polish fast", 2], none: null });
    assert.deepEqual(llm.requests.slice(before).map(lastUser), ["after"]);
  } finally { llm.server.close(); }
});

test("agent() in Python keeps one conversation across turns, and --resume restores it", { skip }, async () => {
  let failThird = true;
  const llm = await fakeLlm((req) => {
    if (lastUser(req) === "third" && failThird) return { status: 400 };
    return { content: `${lastUser(req)} sees ${req.messages.filter((m) => m.role === "user").length}` };
  });
  try {
    let home = "";
    const prepare = (h: string) => {
      home = h;
      write(h, "chat.py", [
        "import asyncio",
        "from agentsh import agent",
        "",
        "async def main():",
        '    a = agent(None, tools=[], system="You remember.")',
        '    one = await a.ask("first")',
        '    two, three = await asyncio.gather(a.ask("second"), a.ask("third"))',
        '    return "; ".join([one, two, three])',
      ]);
    };
    const first = await runCli(RUN("chat.py"), llm.url, { prepare, keepHome: true });
    assert.equal(first.code, 1, first.stderr);
    assert.equal(llm.requests.length, 3);

    failThird = false;
    const second = await runCli(RUN("chat.py", "--resume", runId(first.stdout)), llm.url, { home });
    assert.equal(second.code, 0, second.stderr);
    assert.match(second.stdout, /^first sees 1; second sees 2; third sees 3\n/);
    assert.equal(llm.requests.length, 4, "only the failed turn runs again, with the earlier turns restored");
  } finally { llm.server.close(); }
});

for (const [name, lines, code, message] of [
  ["a file with a syntax error", ["def main(:"], 1, /could not load campaign\.py: SyntaxError/],
  ["a file that fails to import", ["import no_such_module_here", "async def main(): pass"], 2, /could not load .*campaign\.py: [\s\S]*ModuleNotFoundError/],
  ["a file without async def main()", ["def main(): pass"], 2, /must define `async def main\(\)`/],
  ["a config that isn't a literal", ["import os", "config = dict(hours=os.cpu_count())", "async def main(): pass"], 1, /config must be a literal/],
  ["a config key nothing handles", ["config = dict(budgetToken=5)", "async def main(): pass"], 2, /config\.budgetToken is set but nothing handles it/],
  ["an interpreter that isn't there", ['config = dict(python="./venv/bin/python")', "async def main(): pass"], 2, /venv\/bin\/python not found/],
] as const) {
  test(`a Python file is refused before any model call: ${name}`, { skip }, async () => {
    const llm = await fakeLlm(() => ({ content: "ok" }));
    try {
      const r = await runCli(RUN("campaign.py"), llm.url, { prepare: (home) => write(home, "campaign.py", [...lines]) });
      assert.equal(r.code, code, r.stderr + r.stdout);
      assert.match(r.stderr + r.stdout, message);
      assert.equal(llm.requests.length, 0);
    } finally { llm.server.close(); }
  });
}

test("an exception in the Python script fails the run with its traceback; --help and --dry-run work", { skip }, async () => {
  const llm = await fakeLlm(() => ({ content: "ok" }));
  const file = [
    'description = "Fails on purpose."',
    'args = dict(target="src")',
    "from agentsh import run",
    "async def main(args):",
    '    await run(None, f"look at {args.target}")',
    '    raise ValueError("no good")',
  ];
  try {
    const prepare = (home: string) => write(home, "campaign.py", file);
    const failed = await runCli(RUN("campaign.py"), llm.url, { prepare });
    assert.equal(failed.code, 1, failed.stderr);
    assert.match(failed.stdout, /Workflow "campaign" failed: no good\n[\s\S]*ValueError: no good/);

    const help = await runCli(RUN("campaign.py", "--help"), llm.url, { prepare });
    assert.match(help.stdout, /Usage: agent-sh run campaign\.py \[--target <text>\]\n\nFails on purpose\./);

    const before = llm.requests.length;
    const dry = await runCli(RUN("campaign.py", "--dry-run", "--target", "lib"), llm.url, { prepare });
    assert.match(dry.stderr, /\[1 ad-hoc\] \(dry run\) look at lib/);
    assert.equal(llm.requests.length, before);
  } finally { llm.server.close(); }
});

test("on macOS, a sandboxed run confines the Python script itself", { skip: skip || process.platform !== "darwin" }, async () => {
  // Outside the temp dirs, which Seatbelt leaves writable by design.
  const ws = mkdtempSync(join(fileURLToPath(new URL("../..", import.meta.url)), ".sbx-test-"));
  const llm = await fakeLlm(() => ({ content: "ok" }));
  try {
    write(ws, "campaign.py", [
      "import os",
      "from agentsh import run",
      'config = dict(sandbox=dict(write=["./out"]))',
      "here = os.path.dirname(os.path.abspath(__file__))",
      "async def main():",
      '    open(os.path.join(here, "out", "inside.txt"), "w").write(await run(None, "say ok", tools=[]))',
      "    try:",
      '        open(os.path.join(here, "outside.txt"), "w").write("x")',
      "    except OSError as err:",
      '        return f"blocked: {type(err).__name__}"',
      '    return "wrote outside"',
    ]);
    const r = await runCli(["run", join(ws, "campaign.py"), "-e", SUBAGENTS, "-e", SANDBOX], llm.url);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /os sandbox: on \(seatbelt\)/);
    assert.match(r.stdout, /^blocked: PermissionError\n/);
    assert.ok(existsSync(join(ws, "out", "inside.txt")) && !existsSync(join(ws, "outside.txt")));
  } finally {
    llm.server.close();
    rmSync(ws, { recursive: true, force: true });
  }
});
