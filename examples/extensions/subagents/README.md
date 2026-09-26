# subagents

Lets the agent delegate work to subagents that run with their own fresh context. Ideas borrowed from [pi-subagents](https://github.com/nicobailon/pi-subagents): named agents defined in markdown, and parallel fan-out.

## Install

```bash
agent-sh install subagents
```

Or from a checkout: `agent-sh -e ./examples/extensions/subagents`.

## The `spawn_agent` tool

```jsonc
// one subagent
{ "agent": "reviewer", "task": "Review the uncommitted diff" }

// several in parallel; results come back as numbered sections
{ "tasks": [
  { "agent": "reviewer", "task": "Review the diff for correctness" },
  { "agent": "reviewer", "task": "Review the diff for missing tests" },
  { "task": "List every caller of parseConfig", "tools": ["grep", "read_file"] }
] }
```

Leave out `agent` for an ad-hoc subagent; `tools` then picks its tools (default: all). Subagents can't spawn subagents.

Subagent tool calls go through the same `adviseTool` wrappers as the parent's, so extensions like secret-guard still apply.

While subagents run, `spawn_agent` streams one progress line per step as its tool output, which shows under the tool call in the TUI and as `tool_output` events with `agent-sh -p --output json`:

```
[1 reviewer] bash: git show HEAD
[2 reviewer] grep: parseArgs
[2 reviewer] done
[1 reviewer] stopped: step limit reached
```

## Background runs

Add `background: true` to `spawn_agent` or `run_workflow` and the call returns at once (`Started background run #3 (reviewer)`), so the main agent can keep working or talking with you.

- **Status** is added to the main agent's context on every request (`#3 reviewer: running 1m20s (last: grep: parseArgs)`, then `done, unread`). It's never saved to the history.
- **Results** come back only as tool results, when the agent asks with `subagent_jobs` (`result`, `wait`, `list`, `cancel`). Subagent output never enters the history as if you had typed it.
- **Waking:** if a turn ends with a finished run the agent hasn't read, a short note (`[background] Finished: #3 reviewer (done). Read the result with subagent_jobs.`) starts a new turn. A busy agent is never interrupted. Set `backgroundWake: false` to get a notice instead; the agent then sees the status on your next message.
- Ctrl-C on the main turn doesn't stop background runs; `/jobs` lists them and `/jobs cancel <id>` stops one. Resetting the session or `/reload` cancels them all, and they don't survive quitting.
- Foreground and background subagents share the `maxConcurrency` limit.
- `agent-sh -p` stays alive until background runs finish and their wake turn is done.

## Bundled agents

| Agent | Use it for | Edits files |
|---|---|---|
| `scout` | Mapping the relevant code before planning | no |
| `reviewer` | Reviewing a change for bugs, tests, complexity | no |
| `oracle` | A skeptical second opinion on a plan (sees the parent conversation) | no |
| `worker` | Implementing a well-specified change and validating it | yes |
| `delegate` | General delegation that sees the parent conversation | yes |

`/agents` lists every agent found and where it came from.

## Defining agents

An agent is a markdown file; its body is the system prompt.

```markdown
---
name: security-reviewer
description: Reviews a change for injection, auth and secret-handling bugs
tools: read_file, grep, glob, bash
model: gpt-5
thinking: high
maxIterations: 40
inheritContext: false
---

You are a security reviewer. ...
```

| Field | Meaning |
|---|---|
| `name` | Defaults to the file name |
| `description` | Shown to the parent agent so it can choose |
| `tools` | Comma-separated tool names; omit for all tools. pi names (`read`, `write`, `edit`, `find`) are accepted |
| `model` | Model id; must be served by the active provider |
| `thinking` | `off`/`low`/`medium`/`high`; ignored if the model doesn't support reasoning effort |
| `maxIterations` | Tool-loop cap (default from settings) |
| `inheritContext` | `true` gives the subagent the tail of the parent conversation |

Agents load from these directories; a later one overrides an earlier one with the same name:

1. this extension's `agents/`
2. `~/.agent-sh/agents/`
3. `<cwd>/.agent-sh/agents/` (project agents)

Files are re-read on every call, so edits take effect immediately.

## Workflows

A workflow is a script that coordinates subagents with ordinary code: sequences, parallel steps, loops, and branches on typed results. Drop one file in `~/.agent-sh/workflows/` (or `<project>/.agent-sh/workflows/` to share it through the repo) and run it:

```
/workflow                              # list
/workflow review-loop HEAD~3..HEAD     # the main agent runs it and acts on the result
/workflow runs                         # recent runs, with ids and status
/workflow resume <id>                  # continue a failed or interrupted run
```

```ts
export const description = "Review until clean, max 3 rounds";

export default async ({ run, all, args }) => {
  for (let round = 1; round <= 3; round++) {
    const reviews = await all(["correctness", "tests"].map(focus => ({
      agent: "reviewer",
      task: `Review ${args} for ${focus}.`,
      schema: { verdict: { enum: ["clean", "issues"] }, findings: { type: "array", items: { type: "string" } } },
    })));
    if (reviews.every(r => r.verdict === "clean")) return `Clean after ${round} round(s).`;
    await run("worker", `Fix only these findings:\n${reviews.flatMap(r => r.findings).join("\n")}`);
  }
  return "Issues remain after 3 rounds.";
};
```

`run` with a `schema` resolves to validated data rather than text (the agent submits it through a `submit_result` tool), so loops exit on real values instead of pattern-matching prose. `all` returns `null` for runs that failed, a `budget` caps subagent tokens, and every run is logged with a journal and per-agent transcripts under `~/.agent-sh/workflow-runs/`, so a failed or interrupted run can be resumed (`/workflow runs`, `/workflow resume <id>`) without redoing finished steps. The main agent can also run workflows itself (`run_workflow`) and has the authoring guide as a skill, so you can ask it to turn a process into a workflow.

Project workflows are code from the repo, so each one runs only after you review it and run `/workflow trust <name>`; editing the file requires trusting it again. Workflows in `~/.agent-sh/workflows/` are trusted.

Full guide: [WORKFLOWS.md](WORKFLOWS.md). The extension gives the agent two skills: `writing-workflows` (that guide) and `using-subagents` ([USING.md](USING.md): choosing between `spawn_agent`, parallel tasks, background runs and workflows, and running, resuming and debugging workflow runs). Bundled example: [`workflows/review-loop.ts`](workflows/review-loop.ts).

## Settings

```json
{
  "subagents": {
    "maxConcurrency": 4, "maxIterations": 25, "maxRunsPerWorkflow": 50,
    "backgroundWake": true, "workflowTokenBudget": 0
  }
}
```
