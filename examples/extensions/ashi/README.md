# ashi

`ash` (agent-sh's built-in agent) running inside pi's TUI substrate, with no shell underneath.

A test of agent-sh's claim that the kernel is a frontend-agnostic communication layer: `ashi`
uses `createCore()` from agent-sh, skips `activateShell()`, disables the shell-coupled built-ins
(`shell-context`, `tui-renderer`, `file-autocomplete`), and mounts `@earendil-works/pi-tui` as
the only frontend. Backend, tools, slash commands, providers, and skills come along unchanged.

## Setup

```bash
cd examples/extensions/ashi
npm install
npm run build   # or `npm run dev` for a tsx-driven run without compiling
```

`file:../../..` wires `agent-sh` to the parent checkout; run `npm run build` at the repo root
first if you haven't already.

## Install

```bash
agent-sh install ashi
export PATH="$HOME/.agent-sh/bin:$PATH"
ashi
```

`agent-sh install` copies this directory into `~/.agent-sh/extensions/ashi/` (preserving
`node_modules/`, so the local `agent-sh` symlink resolves), then symlinks the built bin into
`~/.agent-sh/bin/`.

## Configure

Reads `~/.agent-sh/settings.json` for providers and defaults, same as `agent-sh` itself. The
quickest path is exporting `OPENROUTER_API_KEY` or `OPENAI_API_KEY` and running `ashi`.

CLI flags mirror `agent-sh`:

```
--provider <name>    Provider profile from ~/.agent-sh/settings.json
--model <id>         Override model
--api-key <key>      Direct API key
--base-url <url>     OpenAI-compatible base URL
--backend <name>     Agent backend (default: ash)
-e, --extensions     Extra extensions to load (comma-separated)
```

## Keybindings

Match pi-coding-agent's convention:

```
Esc      Cancel active turn
Ctrl+C   Clear editor
Ctrl+D   Quit (when editor is empty)
```

## What's intentionally missing

This is a spike, not a clone of pi's full UI. The MVP renders:

- User submissions, streaming assistant Markdown
- Tool invocations with start/complete state
- Slash commands with autocomplete (`/help`, `/model`, `/backend`, …)
- Loader, errors, info messages

Out of scope for v0: permission dialogs, diff renderer, file-path autocomplete, session
selector, theme selector, image rendering. Each can be added by writing a pi-tui Component and
subscribing to the corresponding bus event.
