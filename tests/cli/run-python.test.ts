/** Python run files under `agent-sh run`: the built CLI against a local fake OpenAI-compatible server. */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fakeLlm, lastUser, runCli, SANDBOX, SUBAGENTS, toolCall, type ChatRequest, type RunOpts } from "./fake-llm.js";

// AGENT_SH_PYTHON picks the interpreter under test (e.g. the oldest supported one).
const PYTHON = process.env.AGENT_SH_PYTHON || "python3";
const skip = spawnSync(PYTHON, ["--version"]).status !== 0;
const SOLVE = fileURLToPath(new URL("../../examples/workflows/solve.py", import.meta.url));
const run = (file: string, rest: string[], url: string, opts: RunOpts = {}) =>
  runCli(["run", file, ...rest, "-e", SUBAGENTS], url, { ...opts, env: { AGENT_SH_PYTHON: PYTHON, ...opts.env } });
const write = (home: string, rel: string, lines: string[]) => {
  mkdirSync(join(home, rel, ".."), { recursive: true });
  writeFileSync(join(home, rel), lines.join("\n") + "\n");
};
const typed = (req: ChatRequest) => req.tools?.some((t) => t.function.name === "submit_result");
const runId = (stdout: string) => stdout.match(/\(workflow run (\S+);/)![1]!;
const result = (stdout: string) => JSON.parse(stdout.split("\n\n(workflow run ")[0]!);

test("a Python file: a dataclass as the answer's shape, asyncio.gather, declared args and print", { skip }, async () => {
  const llm = await fakeLlm((req) => {
    if (typed(req)) return toolCall("submit_result", { done: false, tasks: ["a", "boom", "c"] });
    if (lastUser(req) === "boom") return { status: 400 };
    return { content: lastUser(req).toUpperCase() };
  });
  try {
    const r = await run("campaign.py", ["lib", "--rounds", "5"], llm.url, {
      prepare: (home) => write(home, "campaign.py", [
        "import asyncio",
        "from dataclasses import dataclass",
        "from agentsh import RunError, run",
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
        '    plan = await run(f"""',
        "        plan {args.target}",
        '    """, agent="explore", returns=Plan)',
        '    print("planned", len(plan.tasks), "rounds", args.rounds)',
        "    answers = await asyncio.gather(*[run(task, tools=[]) for task in plan.tasks], return_exceptions=True)",
        '    return {"done": plan.done, "answers": [a if isinstance(a, str) else type(a).__name__ for a in answers]}',
      ]),
    });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(result(r.stdout), { done: false, answers: ["A", "RunError", "C"] });
    assert.match(lastUser(llm.requests[0]!), /^plan lib$/);
    assert.match(r.stderr, /· planned 3 rounds 5\n/);
  } finally { llm.server.close(); }
});

test("plain asyncio tasks number their own calls, so --resume reruns only what failed", { skip }, async () => {
  let failTwoB = true;
  const llm = await fakeLlm((req) => (lastUser(req) === "two b" && failTwoB ? { status: 400 } : { content: `did ${lastUser(req)}` }));
  try {
    let home = "";
    const prepare = (h: string) => {
      home = h;
      write(h, "steps.py", [
        "import asyncio",
        "from agentsh import run",
        "",
        "async def two_steps(x):",
        '    await run(f"one {x}", tools=[])',
        '    return await run(f"two {x}", tools=[])',
        "",
        "async def main():",
        '    first = asyncio.create_task(two_steps("a"))',
        '    answers = await asyncio.gather(first, two_steps("b"), two_steps("c"), return_exceptions=True)',
        "    for answer in answers:",
        "        if isinstance(answer, Exception):",
        "            raise answer",
        "    return answers",
      ]);
    };
    const first = await run("steps.py", [], llm.url, { prepare, keepHome: true });
    assert.equal(first.code, 1, first.stderr);
    const runs = join(home, ".agent-sh", "workflow-runs");
    const ids = readFileSync(join(runs, readdirSync(runs)[0]!, "journal.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l).id).sort();
    assert.deepEqual(ids, ["1/1", "1/2", "2/1", "3/1", "3/2"], "each task counts its own calls below its place in main()");

    failTwoB = false;
    const before = llm.requests.length;
    const second = await run("steps.py", ["--resume", runId(first.stdout)], llm.url, { home });
    assert.equal(second.code, 0, second.stderr);
    assert.deepEqual(result(second.stdout), ["did two a", "did two b", "did two c"]);
    assert.deepEqual(llm.requests.slice(before).map(lastUser), ["two b"]);
  } finally { llm.server.close(); }
});

test("@checkpoint saves a function's result; a bare --resume continues the latest run with its arguments", { skip }, async () => {
  let fail = true;
  const llm = await fakeLlm((req) => (fail ? { status: 400 } : { content: `did ${lastUser(req)}` }));
  try {
    let home = "";
    const prepare = (h: string) => {
      home = h;
      write(h, "steps.py", [
        "from agentsh import checkpoint, run",
        "",
        'args = dict(name="nobody")',
        "",
        "@checkpoint",
        "def count(path):",
        '    with open(path, "a") as file:',
        '        file.write("called\\n")',
        "    return sum(1 for _ in open(path))",
        "",
        "async def main(args):",
        '    times = await count("calls.txt")',
        '    answer = await run(f"greet {args.name}", tools=[])',
        '    return f"{answer}; counted {times}"',
      ]);
    };
    const first = await run("steps.py", ["--name", "two words"], llm.url, { prepare, keepHome: true });
    assert.equal(first.code, 1, first.stderr);

    fail = false;
    const second = await run("steps.py", ["--resume"], llm.url, { home, keepHome: true });
    assert.equal(second.code, 0, second.stderr);
    assert.match(second.stderr, new RegExp(`resuming ${runId(first.stdout)}\n\\[checkpoint count\\] reused from`));
    assert.match(second.stdout, /^did greet two words; counted 1\n/);
    assert.equal(readFileSync(join(home, "calls.txt"), "utf8"), "called\n", "the function was not run again");
    rmSync(home, { recursive: true, force: true });

    const none = await run("steps.py", ["--resume"], llm.url, { prepare });
    assert.equal(none.code, 2);
    assert.match(none.stderr, /No earlier run of .*steps\.py to resume\./);
  } finally { llm.server.close(); }
});

test("race keeps the first accepted result and stops the others; --resume reruns only the winner", { skip }, async () => {
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
        '    await run(f"try {x}", tools=[])',
        '    return await run(f"polish {x}", tools=[])',
        "",
        "async def main():",
        '    won = await race(attempt("slow"), attempt("bad"), attempt("fast"), accept=lambda answer: "bad" not in answer)',
        '    nobody = await race(run("try bad", tools=[]), accept=lambda answer: False)',
        '    await run("after", tools=[])',
        '    return {"won": won, "nobody": nobody}',
      ]);
    };
    const first = await run("campaign.py", [], llm.url, { prepare, keepHome: true });
    assert.equal(first.code, 1, first.stderr);
    assert.match(first.stderr, /\[1 ad-hoc\] cancelled/);
    assert.ok(!llm.requests.some((q) => lastUser(q) === "polish slow"));
    const before = llm.requests.length;

    failAfter = false;
    const second = await run("campaign.py", ["--resume", runId(first.stdout)], llm.url, { home });
    assert.equal(second.code, 0, second.stderr);
    assert.deepEqual(result(second.stdout), { won: "did polish fast", nobody: null });
    assert.deepEqual(llm.requests.slice(before).map(lastUser), ["after"]);
  } finally { llm.server.close(); }
});

test("giving up on a call stops its agent: asyncio.wait_for cancels the run", { skip }, async () => {
  const llm = await fakeLlm((req) => (lastUser(req) === "think forever" ? { hang: true } : { content: "ok" }));
  try {
    const r = await run("campaign.py", [], llm.url, {
      prepare: (home) => write(home, "campaign.py", [
        "import asyncio",
        "from agentsh import run",
        "",
        "async def main():",
        "    try:",
        '        await asyncio.wait_for(run("think forever", tools=[]), timeout=0.5)',
        "    except asyncio.TimeoutError:",
        '        return "gave up, then " + await run("carry on", tools=[])',
      ]),
    });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^gave up, then ok\n/);
    assert.match(r.stderr, /\[1 ad-hoc\] cancelled/);
  } finally { llm.server.close(); }
});

test("an Agent keeps one conversation across turns, and --resume restores it", { skip }, async () => {
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
        "from agentsh import Agent",
        "",
        "async def main():",
        '    helper = Agent(tools=[], system="You remember.")',
        '    one = await helper.ask("first")',
        '    two, three = await asyncio.gather(helper.ask("second"), helper.ask("third"))',
        '    return "; ".join([one, two, three])',
      ]);
    };
    const first = await run("chat.py", [], llm.url, { prepare, keepHome: true });
    assert.equal(first.code, 1, first.stderr);
    assert.equal(llm.requests.length, 3);

    failThird = false;
    const second = await run("chat.py", ["--resume", runId(first.stdout)], llm.url, { home });
    assert.equal(second.code, 0, second.stderr);
    assert.match(second.stdout, /^first sees 1; second sees 2; third sees 3\n/);
    assert.equal(llm.requests.length, 4, "only the failed turn runs again, with the earlier turns restored");
  } finally { llm.server.close(); }
});

test("when the budget runs out the program is cancelled, even one that swallows failures in a loop", { skip }, async () => {
  const llm = await fakeLlm(() => ({ content: "ok" }));
  try {
    const r = await run("campaign.py", [], llm.url, {
      prepare: (home) => write(home, "campaign.py", [
        "import asyncio",
        "from agentsh import run",
        "",
        "config = dict(budgetTokens=12)",
        "",
        "async def main():",
        "    while True:",
        '        await asyncio.gather(run("a", tools=[]), run("b", tools=[]), return_exceptions=True)',
      ]),
    });
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stdout, /Workflow "campaign" failed: token budget of 12 exhausted/);
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
      const r = await run("campaign.py", [], llm.url, { prepare: (home) => write(home, "campaign.py", [...lines]) });
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
    '    await run(f"look at {args.target}")',
    '    raise ValueError("no good")',
  ];
  try {
    const prepare = (home: string) => write(home, "campaign.py", file);
    const failed = await run("campaign.py", [], llm.url, { prepare });
    assert.equal(failed.code, 1, failed.stderr);
    assert.match(failed.stdout, /Workflow "campaign" failed: no good\n[\s\S]*ValueError: no good/);

    const help = await run("campaign.py", ["--help"], llm.url, { prepare });
    assert.match(help.stdout, /Usage: agent-sh run campaign\.py \[--target <text>\]\n\nFails on purpose\./);

    const before = llm.requests.length;
    const dry = await run("campaign.py", ["--dry-run", "--target", "lib"], llm.url, { prepare });
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
      '    open(os.path.join(here, "out", "inside.txt"), "w").write(await run("say ok", tools=[]))',
      "    try:",
      '        open(os.path.join(here, "outside.txt"), "w").write("x")',
      "    except OSError as err:",
      '        return f"blocked: {type(err).__name__}"',
      '    return "wrote outside"',
    ]);
    const r = await runCli(["run", join(ws, "campaign.py"), "-e", SUBAGENTS, "-e", SANDBOX], llm.url, { env: { AGENT_SH_PYTHON: PYTHON } });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /os sandbox: on \(seatbelt\)/);
    assert.match(r.stdout, /^blocked: PermissionError\n/);
    assert.ok(existsSync(join(ws, "out", "inside.txt")) && !existsSync(join(ws, "outside.txt")));
  } finally {
    llm.server.close();
    rmSync(ws, { recursive: true, force: true });
  }
});

test("the solve example: two tries race, a failed check goes back to the same agent, reviewers judge the winner", { skip }, async () => {
  const wants = (req: ChatRequest, field: string) =>
    req.tools?.some((t) => t.function.name === "submit_result" && field in ((t.function as { parameters?: { properties?: object } }).parameters?.properties ?? {}));
  const llm = await fakeLlm((req) => {
    if (wants(req, "tasks")) return toolCall("submit_result", { tasks: [{ name: "alpha", goal: "do alpha" }, { name: "beta", goal: "do beta" }] });
    if (wants(req, "summary")) return toolCall("submit_result", { summary: "did it", files: ["a.txt"] });
    if (wants(req, "refuted")) return toolCall("submit_result", { refuted: lastUser(req).includes("hard-coded"), reason: "looks stubbed" });
    return { content: "ok" };
  });
  try {
    // Fails the first time it's run in a directory, passes after.
    const check = "test -f {dir}/seen || { touch {dir}/seen; echo no seen file yet; false; }";
    const r = await run("solve.py", ["--goal", "two things", "--check", check], llm.url, {
      prepare: (home) => writeFileSync(join(home, "solve.py"), readFileSync(SOLVE)),
    });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^2\/2 task\(s\) solved\.\n- alpha: solved \(.*\/out\/alpha\/[12]\)\n- beta: solved \(/);
    assert.match(r.stderr, /· alpha: passed after 1 repair\(s\)/);
    const repair = llm.requests.find((q) => lastUser(q).startsWith("The check failed. Fix it.\n\nno seen file yet"))!;
    assert.equal(repair.messages.filter((m) => m.role === "user").length, 2, "the repair turn continues the first conversation");
  } finally { llm.server.close(); }
});
