# Writing workflows

A workflow is a script that coordinates subagents: steps in sequence, steps in parallel, loops, and decisions based on what agents return. The script decides the control flow; the agents do the judgment.

## Where it goes

One `.ts` or `.js` file; the file name is the workflow name. Nothing to build or install.

| Directory | Scope |
|---|---|
| `~/.agent-sh/workflows/` | yours, trusted automatically |
| `<project>/.agent-sh/workflows/` | shared through the repo; each user must run `/workflow trust <name>` once, and again after every edit |

A later directory overrides an earlier one with the same name (bundled < user < project).

## Shape

```ts
export const description = "One line shown in /workflow, --help and to the main agent";

export const args = {                        // optional: parsed from --flags (see "Arguments")
  target: { default: "src", help: "what to review" },
  rounds: 3,
};

export default async ({ run, map, args, log, budget }) => {
  const reviews = await map(["correctness", "tests"], (focus) =>
    run("reviewer", `Review ${args.target} for ${focus}.`, { returns: { verdict: "clean | issues", findings: "string[]" } }));
  // ...
  return "the result";                       // a string, or any JSON-able value
};
```

`description` must be a plain string literal: it is read without running the file.

## API

- `run(agent, task)` — run a named agent; resolves to its final answer (text). `run(null, task)` is an ad-hoc subagent.
- `run(agent, task, { returns })` — resolve to **data** of that shape instead of text. Use it for anything the script branches on:
  ```ts
  const r = await run("reviewer", task, { returns: { verdict: "clean | issues", findings: "string[]" } });
  if (r.verdict === "clean") ...
  ```
  The shape is shorthand (below) or JSON Schema. The agent gets a `submit_result` tool whose parameters are the shape; a submission that doesn't fit is refused with the reason, so the agent fixes it, and the run ends as soon as one is accepted. If the agent answers in text instead, a short LLM call converts the answer (with one retry). If nothing fits, `run` throws.
- `run(null, task, { tools })` — an ad-hoc subagent limited to those tools (named agents keep their own). `run({ agent, task, returns, tools })` also works.
- Per call: `model` and `thinking` override the agent's, `label` names it in progress lines, and for ad-hoc runs `system` sets the role and rules. So a script can define its agents inline, without agent files:
  ```ts
  const proofreader = { system: "You proofread a LaTeX paper. Report only typos, grammar and LaTeX problems.", tools: [], label: "proofreader" };
  const found = await run({ ...proofreader, task: section, returns: ISSUES });
  ```
- `map(items, fn)` — call `fn(item, index)` for every item concurrently (up to `subagents.maxConcurrency`) and resolve to the results in order; **an item whose `fn` fails becomes `null`**. `fn` is ordinary async code, so each item can run several steps (`async (x) => { const a = await run(...); return run(..., a); }`) without waiting for the others.
- `pipeline(items, stage1, stage2, ...)` — each item goes through the stages on its own: an item that finishes stage 1 starts stage 2 without waiting for the others. Each stage gets `(previous result, item, index)`; a stage that throws makes that item `null` and skips its remaining stages. Prefer it to `map` followed by another `map` unless a later step needs all the earlier results together (to merge or dedupe them, say).
- `all([spec, ...])` — like `map` over `run` specs.
- `args` — the parsed arguments when the file declares `export const args`, else everything after the file name as text.
- `log(message)` — a progress line under the tool call (stderr under `agent-sh run`).
- `signal` — aborted on Ctrl-C or at the deadline.
- `budget` — `{ total, spent(), remaining() }` in subagent tokens (prompt + completion). `total` is `null` unless a budget was set (`budgetTokens`, or `subagents.workflowTokenBudget`). Once it's spent, `run()` throws; runs already going finish. Loop on it: `while (budget.total && budget.remaining() > 50_000) { ... }`.

Tasks are dedented: indent a multi-line template literal with your code and the agent sees it flush left (lines you interpolate are left as they are).

### Shapes

| Shorthand | Means |
|---|---|
| `"string"`, `"number"`, `"integer"`, `"boolean"` | that type |
| `"clean \| issues"` | one of those words |
| `"number \| string"` | either type |
| `"string[]"` | a list of strings |
| `"number?"` | optional field (the others are required) |
| `{ file: "string", line: "integer" }` | a nested object |
| `[{ file: "string", line: "integer?" }]` | a list of objects |

Anything else is JSON Schema (`{ type: "object", properties: {...} }` passes through unchanged).

### Arguments

```ts
export const args = {
  target: { default: "the uncommitted changes", help: "what to review" },
  rounds: 3,                         // a bare value is the default; its type is the argument's type
  strict: false,                     // booleans are switches: --strict, --no-strict
  label: { required: true },
};
```

`agent-sh run review.ts lib/cli --rounds 5 --strict` gives `args = { target: "lib/cli", rounds: 5, strict: true, label: ... }`. Flags may be kebab-case (`--max-rounds` for `maxRounds`); leftover words fill the first text argument. An unknown flag, a missing required one or a non-number stops the run with the usage text, and `agent-sh run review.ts --help` prints it. Through `run_workflow` or `/workflow`, the same flags come as text: `/workflow review "lib dir" --rounds 2`.

### Trying a script

`agent-sh run file.ts --dry-run` runs the script without calling any model: each `run` answers with a placeholder of its shape (the first choice, `false`, `0`, a one-item list, `"<field>"`), unknown agents are reported, and every call is printed. Use it to check loops, branches and arguments before spending tokens.

Budget exhaustion, the run cap, the deadline and Ctrl-C stop the whole workflow; `map()`, `pipeline()` and `all()` never turn them into `null`.

## Runs, logs and resuming

Every run gets an id and a folder in `~/.agent-sh/workflow-runs/<id>/`:

- `run.json` — workflow, args, status, tokens, error
- `journal.jsonl` — each completed `run()`: its inputs' hash and its result
- `agents/<n>.jsonl` — the full transcript of subagent run *n* (task, every message and tool result)

`/workflow runs` lists recent runs (a run still marked running after agent-sh exited shows as interrupted). To resume a failed or interrupted run, fix the cause (or edit the workflow), then `/workflow resume <id>`, or have the agent call `run_workflow { resume: "<id>" }`.

Resuming reruns the script from the top. Each `run()` call is identified by where it sits: top-level calls in the order the script makes them, and calls inside a `map` or `pipeline` item in that item's own order, so it doesn't matter which item finishes first. A call reuses the old result if its inputs (agent, task, tools, returns, system, model, thinking) are unchanged. The first call whose inputs changed, and every later call in the same branch, runs live. Runs that failed or never finished run again. For this to work the script must make the same calls in the same order given the same results, so don't let `Date.now()`, `Math.random()` or other outside state decide what to run. Side effects the script performs itself (files, commands) are not replayed.

Agents are the named ones from `/agents` (`explore`, `plan`, `research`, `reviewer`, `oracle`, `worker`, `delegate`, plus ones from other extensions, the user and the project). Subagents can't start subagents or workflows.

## Rules of thumb

- Put loop exits on `returns` data, never on regexes over prose.
- Always cap loops (`for (let round = 1; round <= 3; round++)`); separately, a workflow may start at most `subagents.maxRunsPerWorkflow` subagents (default 50).
- Write self-contained tasks: subagents don't see the main conversation (except agents with `inheritContext: true`).
- Pass results forward explicitly, e.g. include an explore run's output in the next task.
- Only one writing agent (`worker`) at a time on the same files.

## Patterns

A workflow is worth writing when its structure buys something a single agent can't: coverage (several angles in parallel), confidence (independent checks before trusting a claim), or scale. These patterns are the usual building blocks; combine them freely.

**Verify adversarially.** Don't trust a finding because one agent said it. Give it to several skeptics told to *refute* it, defaulting to "refuted" when they can't confirm it, and keep it only if most fail. A skeptic that failed (`null`) should count against the finding.

```ts
const votes = (await map([1, 2, 3], () => run("reviewer",
  `Try to refute: ${claim}. Answer refuted=true if you can't confirm it from the code.`,
  { returns: { refuted: "boolean", reason: "string" } }))).filter(Boolean);
const survives = votes.filter(v => !v.refuted).length >= 2;
```

**Verify from different angles.** When a claim can be wrong in more than one way, give each verifier a different angle (does it really happen? is it reachable? is it intended?) instead of the same prompt three times. Diversity catches failures that repetition can't.

**Search several ways.** Run finders that each look differently (by concern, by file, by entry point, by recent change). Each is blind to what the others surface.

**Dedupe cheaply, but don't lose distinct findings.** Group in code by a coarse key such as the file; it needs everything at once, so it's the one place to wait for all finders. Don't dedupe on the key itself: finders describe the same bug in different words and cite different lines, and one line can hold several bugs. When a group has several claims, one small merge run ("merge repeats, keep distinct problems separate") is far cheaper than verifying duplicates, and far safer than dropping all but one. Log how many merged into how many.

**Don't wait when you don't have to.** Otherwise let each item move through its stages on its own, so one slow item doesn't hold up the rest:

```ts
const results = await map(items, async (item) => {
  const draft = await run("worker", fixTask(item));
  return run("reviewer", checkTask(item, draft), { returns: VERDICT });
});
```

**Loop until nothing new.** For discovery of unknown size, keep sending finders until two rounds in a row add nothing new. Dedupe against everything *seen*, not just what was confirmed, or rejected findings come back every round and the loop never ends:

```ts
const seen = new Set<string>();
for (let dry = 0, round = 1; dry < 2 && round <= 5; round++) {
  const fresh = (await map(FINDERS, (f) => run("reviewer", f.task, { returns: FINDINGS })))
    .filter(Boolean).flatMap((r) => r.findings).filter((f) => !seen.has(key(f)));
  if (!fresh.length) { dry++; continue; }
  dry = 0;
  fresh.forEach(f => seen.add(key(f)));
  // verify `fresh` ...
}
```

**Judge panel.** When there are many possible solutions (a design, an approach), generate several independent attempts from different angles, have judges score them against the same criteria, then build from the winner and borrow the best ideas from the runners-up.

**Ask what's missing.** Finish with an agent that asks what was not covered: an angle not searched, a claim not verified, a file not read. What it names becomes the next round, or goes in the report.

**No silent caps.** If you limit coverage (top N, sampling, no retry), `log()` what was left out and say so in the result. A truncated review that reads as complete is worse than a slower one.

**Scale to the request.** "Any obvious bugs?" is a few finders with one check each. "Audit this thoroughly" is more finders, three to five skeptics per finding, and a final synthesis. Watch `budget.remaining()` for open-ended loops.

## Running

- `/workflow` lists workflows; `/workflow <name> <args>` asks the main agent to run it and act on the result.
- The main agent can call the `run_workflow` tool itself.
- Directly, with no main agent: `agent-sh run <file> [args]`. The file may also `export const config = { agents, model, provider, concurrency, maxRuns, maxIterations, budgetTokens, hours, sandbox }` to declare its setup (see docs/usage.md "Run files"), so a whole campaign lives in one file. `--resume <id>` continues a failed run. Progress goes to stderr: a line when each subagent starts and finishes, and a "2 working, 5 queued" line after a quiet minute. From another terminal (or for a run under nohup), `agent-sh run --status [id]` shows each subagent's state and how long it has been in it.
- Through the main agent, e.g. in CI: `agent-sh -p "run the <name> workflow on <args>"`.

## Examples

Bundled, next to this file in `workflows/`:

- `review-loop.ts`: one reviewer per `--focus` angle with a typed verdict, a worker fixing the findings, repeated until clean or `--rounds`.
- `research.ts`: a planner splits the question, research agents answer the parts in parallel, a reviewer checks the claims against their sources, and a final run combines the answer with sources and names what failed.

In the repo's `examples/workflows/` (copy into `~/.agent-sh/workflows/` to use):

- `campaign.ts`: a run-file template with `config`, declared args and a sandbox.
- `verified-review.ts`: three finders looking different ways, grouped by file with a merge run for files with several claims, then three skeptics per finding attacking it from different angles; only findings most skeptics fail to refute are reported, and merges and caps are logged.
