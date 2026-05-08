# claude-code-bridge

Runs Claude Code as an agent-sh backend using the official [@anthropic-ai/claude-agent-sdk](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk).

## Install

```bash
agent-sh install claude-code-bridge
```

This copies the bundled extension into `~/.agent-sh/extensions/claude-code-bridge` and runs `npm install` for you. To overwrite an existing install, pass `--force`. To uninstall, run `agent-sh uninstall claude-code-bridge`.

Manual alternative (e.g. for a development checkout you want to symlink):

```bash
cp -r examples/extensions/claude-code-bridge ~/.agent-sh/extensions/claude-code-bridge
cd ~/.agent-sh/extensions/claude-code-bridge && npm install
```

## Configure

Set as default backend in `~/.agent-sh/settings.json`:

```json
{
  "defaultBackend": "claude-code"
}
```

Or switch at runtime:

```
? /backend claude-code
```

## Requirements

- `ANTHROPIC_API_KEY` must be set in your environment
- Claude Code manages its own model selection — no model configuration needed in agent-sh

## What works under claude-code

agent-sh's per-query context producers (e.g. `<shell_events>` from `shell-context`) are inlined into the prompt before each query, so claude-code sees the user's recent shell activity even though the SDK doesn't subscribe to agent-sh's shell bus directly.

The SDK's working directory follows agent-sh's PTY-tracked cwd, so when the user `cd`s in the terminal, claude-code's tools (Bash, Read, etc.) operate in the new directory.

## What this bridge is

A pure protocol translator between the Claude Agent SDK's event stream and agent-sh's bus events. Claude Code uses its own built-in tools exactly as the SDK ships them (`Read`, `Edit`, `Write`, `Bash`, `Glob`, `Grep`). The bridge adds no tools of its own.
