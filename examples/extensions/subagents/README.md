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

## Settings

```json
{
  "subagents": { "maxConcurrency": 4, "maxIterations": 25 }
}
```
