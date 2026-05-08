# pi-bridge

Runs [pi](https://github.com/badlogic/pi-mono) (`@mariozechner/pi-coding-agent`) as an agent-sh backend. Pi brings its own configuration, models, tools, and extensions — agent-sh just provides the terminal.

## Install

```bash
agent-sh install pi-bridge
```

This copies the bundled extension into `~/.agent-sh/extensions/pi-bridge` and runs `npm install` for you. To overwrite an existing install, pass `--force`. To uninstall, run `agent-sh uninstall pi-bridge`.

Manual alternative (e.g. for a development checkout you want to symlink):

```bash
cp -r examples/extensions/pi-bridge ~/.agent-sh/extensions/pi-bridge
cd ~/.agent-sh/extensions/pi-bridge && npm install
```

## Configure

Set as default backend in `~/.agent-sh/settings.json`:

```json
{
  "defaultBackend": "pi"
}
```

Or switch at runtime:

```
> /backend pi
```

Pi reads its own settings from `~/.pi/agent/settings.json`. Configure API keys and model preferences there (or run `pi` directly to set up auth) — agent-sh does not override pi's configuration.

## What works under pi

These slash commands are routed to pi's SDK when pi is the active backend:

- `/model` — lists/switches pi's available models (`session.setModel`)
- `/thinking` — sets pi's thinking level (`off/minimal/low/medium/high/xhigh`)
- `/compact` — runs `session.compact()` on pi's session
- `/context` — reports pi's token usage (`session.getContextUsage()`)

agent-sh's per-query context producers (e.g. `<shell_events>` from `shell-context`) are inlined into pi's prompt before each query, so pi sees the user's recent shell activity even though it doesn't subscribe to agent-sh's shell bus directly.

## What this bridge is

A pure protocol translator between pi's event stream and agent-sh's bus events. Pi's built-in tools (command execution, file ops, etc.) are used exactly as pi ships them. The bridge adds no tools of its own.
