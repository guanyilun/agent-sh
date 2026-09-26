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
export const description = "One line shown in /workflow and to the main agent";

export default async ({ run, all, args, log, signal }) => {
  // ...
  return "the result";   // a string, or any JSON-able value
};
```

`description` must be a plain string literal: it is read without running the file.

## API

- `run(agent, task)` — run a named agent, resolve to its final answer (text).
- `run({ agent?, task, tools?, schema? })` — the same, as an object. Omit `agent` for an ad-hoc subagent limited to `tools`.
- `run({ ..., schema })` — resolve to **data** matching the schema instead of text. Use this for anything the script branches on. A plain map of property → schema means an object requiring all of them:
  ```ts
  const r = await run({ agent: "reviewer", task, schema: {
    verdict: { enum: ["clean", "issues"] },
    findings: { type: "array", items: { type: "string" } },
  } });
  if (r.verdict === "clean") ...
  ```
  The agent gets a `submit_result` tool whose parameters are the schema; a submission that doesn't fit is refused with the reason, so the agent fixes it, and the run ends as soon as one is accepted. If the agent answers in text instead, a short LLM call converts the answer (with one retry). If nothing fits, `run` throws.
- `all([spec, ...])` — run specs concurrently (up to `subagents.maxConcurrency`) and resolve to results in order; **a run that fails becomes `null`**, so filter before use: `(await all(specs)).filter(Boolean)`. `run()` on its own throws on failure.
- `args` — everything after the workflow name, as a string.
- `log(message)` — a progress line under the tool call.
- `signal` — aborted on Ctrl-C.
- `budget` — `{ total, spent(), remaining() }` in subagent tokens (prompt + completion). `total` is `null` unless a budget was set (`budgetTokens` on the call, or `subagents.workflowTokenBudget`). Once it's spent, `run()` throws; runs already going finish. Loop on it: `while (budget.total && budget.remaining() > 50_000) { ... }`.

Budget exhaustion, the run cap and Ctrl-C stop the whole workflow; `all()` never turns them into `null`.

## Runs, logs and resuming

Every run gets an id and a folder in `~/.agent-sh/workflow-runs/<id>/`:

- `run.json` — workflow, args, status, tokens, error
- `journal.jsonl` — each completed `run()`: its inputs' hash and its result
- `agents/<n>.jsonl` — the full transcript of subagent run *n* (task, every message and tool result)

`/workflow runs` lists recent runs (a run still marked running after agent-sh exited shows as interrupted). To resume a failed or interrupted run, fix the cause (or edit the workflow), then `/workflow resume <id>`, or have the agent call `run_workflow { resume: "<id>" }`.

Resuming reruns the script from the top. Each `run()` call, numbered in the order the script makes it, reuses the old result if its inputs (agent, task, tools, schema) are unchanged. The first call whose inputs changed, and every call after it, runs live. Runs that failed or never finished run again. For this to work the script must make the same calls in the same order given the same results, so don't let `Date.now()`, `Math.random()` or other outside state decide what to run. Side effects the script performs itself (files, commands) are not replayed.

Agents are the named ones from `/agents` (`scout`, `reviewer`, `oracle`, `worker`, `delegate`, plus user/project ones). Subagents can't start subagents or workflows.

## Rules of thumb

- Put loop exits on `schema` results, never on regexes over prose.
- Always cap loops (`for (let round = 1; round <= 3; round++)`); separately, a workflow may start at most `subagents.maxRunsPerWorkflow` subagents (default 50).
- Write self-contained tasks: subagents don't see the main conversation (except agents with `inheritContext: true`).
- Pass results forward explicitly, e.g. include a scout's output in the next task.
- Only one writing agent (`worker`) at a time on the same files.

## Patterns

A workflow is worth writing when its structure buys something a single agent can't: coverage (several angles in parallel), confidence (independent checks before trusting a claim), or scale. These patterns are the usual building blocks; combine them freely.

**Verify adversarially.** Don't trust a finding because one agent said it. Give it to several skeptics told to *refute* it, defaulting to "refuted" when they can't confirm it, and keep it only if most fail. A skeptic that failed (`null`) should count against the finding.

```ts
const votes = (await all([1, 2, 3].map(() => ({
  agent: "reviewer",
  task: `Try to refute: ${claim}. Answer refuted=true if you can't confirm it from the code.`,
  schema: { refuted: { type: "boolean" }, reason: { type: "string" } },
})))).filter(Boolean);
const survives = votes.filter(v => !v.refuted).length >= 2;
```

**Verify from different angles.** When a claim can be wrong in more than one way, give each verifier a different angle (does it really happen? is it reachable? is it intended?) instead of the same prompt three times. Diversity catches failures that repetition can't.

**Search several ways.** Run finders that each look differently (by concern, by file, by entry point, by recent change). Each is blind to what the others surface.

**Dedupe cheaply, but don't lose distinct findings.** Group in code by a coarse key such as the file; it needs everything at once, so it's the one place to wait for all finders. Don't dedupe on the key itself: finders describe the same bug in different words and cite different lines, and one line can hold several bugs. When a group has several claims, one small merge run ("merge repeats, keep distinct problems separate") is far cheaper than verifying duplicates, and far safer than dropping all but one. Log how many merged into how many.

**Don't wait when you don't have to.** Otherwise let each item move through its stages on its own, so one slow item doesn't hold up the rest:

```ts
const results = await Promise.all(items.map(async (item) => {
  const draft = await run({ agent: "worker", task: fixTask(item) });
  return run({ agent: "reviewer", task: checkTask(item, draft), schema: VERDICT });
}));
```

**Loop until nothing new.** For discovery of unknown size, keep sending finders until two rounds in a row add nothing new. Dedupe against everything *seen*, not just what was confirmed, or rejected findings come back every round and the loop never ends:

```ts
const seen = new Set<string>();
for (let dry = 0, round = 1; dry < 2 && round <= 5; round++) {
  const fresh = (await all(FINDERS)).filter(Boolean).flatMap(r => r.findings).filter(f => !seen.has(key(f)));
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
- Headless (CI): `agent-sh -p "run the <name> workflow on <args>"` with the extension installed.

## Examples

Next to this file, in `workflows/`:

- `review-loop.ts`: parallel reviewers with a typed verdict, a worker fixing the findings, repeated until clean or three rounds.
- `verified-review.ts`: three finders looking different ways, grouped by file with a merge run for files with several claims, then three skeptics per finding attacking it from different angles; only findings most skeptics fail to refute are reported, and merges and caps are logged.
