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

## Running

- `/workflow` lists workflows; `/workflow <name> <args>` asks the main agent to run it and act on the result.
- The main agent can call the `run_workflow` tool itself.
- Headless (CI): `agent-sh -p "run the <name> workflow on <args>"` with the extension installed.

## Example

See `workflows/review-loop.ts` next to this file: parallel reviewers with a typed verdict, a worker fixing findings, repeated until clean or three rounds.
