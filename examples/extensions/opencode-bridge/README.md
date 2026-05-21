# opencode-bridge

Runs [opencode](https://opencode.ai/) as an agent-sh backend using the official [@opencode-ai/sdk](https://www.npmjs.com/package/@opencode-ai/sdk). opencode brings its own configuration, models, tools, and authentication — agent-sh just provides the terminal.

## Install

```bash
agent-sh install opencode-bridge
```

This copies the bundled extension into `~/.agent-sh/extensions/opencode-bridge` and runs `npm install` for you. To overwrite an existing install, pass `--force`. To uninstall, run `agent-sh uninstall opencode-bridge`.

Manual alternative (e.g. for a development checkout you want to symlink):

```bash
cp -r examples/extensions/opencode-bridge ~/.agent-sh/extensions/opencode-bridge
cd ~/.agent-sh/extensions/opencode-bridge && npm install
```

## Configure

Set as default backend in `~/.agent-sh/settings.json`:

```json
{
  "defaultBackend": "opencode"
}
```

Or switch at runtime:

```
> /backend opencode
```

opencode reads its own config from `~/.local/share/opencode/` (auth credentials) and `opencode.json` / `opencode.jsonc` in your project. Configure providers and authentication by running `opencode auth login` directly — agent-sh does not override opencode's configuration.

## Requirements

- opencode authenticated locally — run `opencode auth login` once before using this bridge.
- Provider env vars (e.g. `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`) as required by opencode for the model you've selected.

## Environment

- `OPENCODE_SDK_PORT` — port for the in-process opencode HTTP server. Defaults to `0` (OS-assigned free port) so a stale standalone opencode on the SDK's default port 4096 can't collide with the bridge. Set explicitly only if you need a deterministic port.

## What works under opencode

agent-sh's per-query context producers (e.g. `<shell_events>` from `shell-context`) are inlined into opencode's prompt before each query, so opencode sees the user's recent shell activity even though the SDK doesn't subscribe to agent-sh's shell bus directly. The current cwd is part of that context, so opencode knows where the user is even when its tools are anchored elsewhere.

## cwd handling

opencode treats the `directory` query param as a project ID and routes its event stream per-project — switching project mid-session silences the SSE channel we already subscribed to (no tool events, no streaming text). Because of that, the bridge **pins the session to the directory agent-sh launched from** and does not propagate later in-shell `cd`s to opencode. opencode's tools (`Bash`, `Read`, `Edit`, etc.) operate from that pinned directory; the agent learns the user's real cwd from `<shell_events>` and can still reach other locations through absolute paths or `cd && cmd` in `Bash`.

To re-anchor the agent to your current cwd, run `/reset` — it tears down the conversation and creates a fresh session in your present directory.

## Permission prompts

opencode supports a `permission.edit = "ask"` config in `opencode.json` that gates write/edit tools behind an approval. The bridge has no UI primitive for showing that prompt, so it **auto-approves each request once** — without this, write/edit tool calls hang forever waiting for a reply that never comes. This matches claude-code-bridge's `permissionMode: "acceptEdits"` behavior. If you want to actually gate edits, set `permission.edit` to `"allow"` (skip the prompt entirely) or run opencode standalone for the interactive flow.

## What this bridge is

A pure protocol translator between opencode's SSE event stream and agent-sh's bus events. opencode runs as an in-process HTTP server (booted by `createOpencode()`); the bridge consumes its global event stream, filters by the active session's ID, and translates `message.part.updated` events (text/reasoning deltas, `ToolPart.state` transitions) into agent-sh tool/response events. opencode's built-in tools (bash, edit, read, write, grep, glob, etc.) are used exactly as opencode ships them. The bridge adds no tools of its own.
