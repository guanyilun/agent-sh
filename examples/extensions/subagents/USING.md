# Using subagents and workflows

## Pick the right tool

| Situation | Use |
|---|---|
| One focused job whose steps you don't need to see (explore, review, implement) | `spawn_agent { agent, task }` |
| Several independent jobs | `spawn_agent { tasks: [...] }` (runs in parallel, results in numbered sections) |
| A slow job while you keep working or talking with the user | add `background: true` |
| A repeatable process with fixed steps, loops or branches | a workflow: `run_workflow { name, args }` |
| The same multi-step process you'd otherwise orchestrate by hand again and again | propose writing a workflow (see the `writing-workflows` skill) |

Named agents (list them with `/agents`): `scout` maps code (read-only), `reviewer` reviews (read-only), `oracle` gives a skeptical second opinion and sees this conversation, `worker` implements and validates, `delegate` acts like you and sees this conversation. Prefer a named agent over an ad-hoc one.

## Writing a good task

- Subagents start fresh: they don't see this conversation unless the agent inherits context (`oracle`, `delegate`). Put everything they need in the task: paths, the goal, constraints, what to return.
- Say what shape of answer you want ("list findings as path:line + scenario").
- Only their final answer comes back. Their tool calls and reasoning never reach you, which is the point: it keeps your context small.
- Never run two writing agents (`worker`, `delegate`) on the same files at once, and don't background a writer on files you're editing yourself.

## Background runs

- `background: true` returns at once with a run number (`#3`). Its status appears in your dynamic context each request (`#3 reviewer: running 1m20s (last: ...)`, then `done, unread`).
- Results come back only through `subagent_jobs`: `result` (one finished run), `wait` (block until one or all running runs finish; `timeoutSeconds`), `list`, `cancel`.
- If your turn ends with an unread result, a short `[background] Finished: ...` note starts a new turn. Read the result with `subagent_jobs` before summarizing it, and never guess what a pending run will say.
- Ctrl-C on your turn doesn't stop background runs. The user can list or stop them with `/jobs` and `/jobs cancel <id>`.

## Running workflows

- `run_workflow { name, args }` runs a saved workflow; your tool description lists the available ones. A project workflow marked untrusted can't run until the **user** reviews it and runs `/workflow trust <name>`. Ask them; you can't trust it yourself.
- `budgetTokens` caps subagent tokens for the run. Suggest one for anything large; the user may also set `subagents.workflowTokenBudget`.
- Every result ends with `(workflow run <id>; log: <dir>)`. Keep the id: you need it to resume or debug.

## When a workflow fails or is interrupted

1. Read the error in the tool result, then look in the run folder `~/.agent-sh/workflow-runs/<id>/`:
   - `run.json`: status, args, tokens, error
   - `journal.jsonl`: one line per completed subagent run (`seq`, `agent`, `output`, `tokens`)
   - `agents/<n>.jsonl`: the full transcript of run *n*: its task, every message, tool call and result
2. Fix the cause (a flaky provider, a bad task in the script, a missing file), then resume with `run_workflow { resume: "<id>" }`. The earlier args are reused unless you pass new ones.
3. Resuming reruns the script and reuses each finished subagent result whose inputs are unchanged. After an edit, everything from the first changed `run()` on runs live, and runs that failed or never finished run again. Tell the user roughly what will be reused before resuming an expensive run.
4. `/workflow runs` lists recent runs; ones marked "interrupted" were cut off (the process exited) and can be resumed the same way.

## Commands to suggest to the user

`/agents`, `/workflow` (list), `/workflow <name> <args>`, `/workflow trust <name>`, `/workflow runs`, `/workflow resume <id>`, `/jobs`, `/jobs cancel <id>`.

Settings live under `subagents` in `~/.agent-sh/settings.json`: `maxConcurrency`, `maxIterations`, `maxRunsPerWorkflow`, `backgroundWake`, `workflowTokenBudget`.
