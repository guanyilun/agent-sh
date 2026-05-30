# agent-sh

[![npm version](https://img.shields.io/npm/v/agent-sh.svg)](https://www.npmjs.com/package/agent-sh)
[![license](https://img.shields.io/npm/l/agent-sh.svg)](https://github.com/guanyilun/agent-sh/blob/main/LICENSE)

A composable agent runtime — pair any frontend with any agent backend, over one shared extension layer.

## Three example apps built on agent-sh

agent-sh is small at its core and does its real work through extensions, so the same runtime drives very different apps. Three to start with — all sharing the same agent backends, tools, providers, and `~/.agent-sh/settings.json`:

### 1. A shell with the agent one keystroke away — bundled with agent-sh

A normal shell on top of node-pty — your rc config, your aliases, vim and tmux all just work. But at the start of any line, type `>` and you're talking to a small agent that already sees your cwd, your last command, and its output. Nothing to set up, no project to explain.

![demo](assets/demo.gif)

```
~ $ ls -la                       # real shell command
~ $ cd ../tests && npm test      # real cd, env, aliases — all just work
~ $ vim file.ts                  # opens vim in the same PTY
~ $ > explain the last error     # agent investigates using its own tools
~ $ > draft a commit message     # agent reads your diff and shell history
```

```bash
npm install -g agent-sh
```

[Quick Start ↓](#quick-start)

### 2. ashi — a standalone coding agent

[**`@guanyilun/ashi`**](examples/extensions/ashi/) is the same `ash` agent in a chat-style TUI, with no shell underneath — just the agent. Installed separately, it reuses agent-sh's backend, tools, slash commands, providers, and skills, and adds session history, in-session branching, and LLM-driven compaction.

```bash
npm install -g @guanyilun/ashi
ashi
```

### 3. asHub — a GUI coding agent

[**firslov/asHub**](https://github.com/firslov/asHub) is a third-party cross-platform desktop app (Electron) built on the agent-sh runtime: a multi-session sidebar, persistence across restarts, and a live-streaming interface with Markdown, syntax-highlighted code, diffs, and tool-call rendering. macOS / Windows / Linux.

## How it works

agent-sh is a **composable agent runtime**. At its center is a pure kernel — a typed event bus, a named-handler registry, and an extension loader — that knows nothing about terminals, LLMs, shells, or rendering. Everything else plugs into it: the agent backend, its tools, provider management, and the frontend that drives it.

The frontend and the agent backend are both just components on the bus, so you **mix and match** them freely — wire several frontends to one backend, or keep one frontend and swap the backend underneath — all sharing the **same extension layer** of tools, content transforms, slash commands, and themes. `import { createCore } from "agent-sh"` gives you the headless kernel; load the pieces you want and wire your own I/O.

For the kernel design in full — the bus, handlers, the compositor, and the shell ↔ agent boundary — see [Architecture](docs/architecture.md). To embed the runtime in your own frontend, see the [Library Guide](docs/library.md). The rest of this README covers the bundled shell.

## Quick Start

**This sets up the agent-sh shell** — the frontend bundled in the `agent-sh` package. (For the other frontends, install [ashi](examples/extensions/ashi/) or [asHub](https://github.com/firslov/asHub) instead.)

### Installation

Install from npm:

```bash
npm install -g agent-sh
```

Re-run the same command to update. Patch releases ship frequently; `npm update -g agent-sh` works too.

For unreleased changes on `main`, clone and link locally — this avoids `npm install -g github:...`, which builds on your machine and requires a working TypeScript toolchain:

```bash
git clone https://github.com/guanyilun/agent-sh.git
cd agent-sh
npm install        # installs devDependencies (typescript, etc.)
npm run build      # produces dist/
npm link           # exposes `agent-sh` globally
```

Requires Node.js 18+. Supports **bash**, **zsh**, and **fish**; other shells (nushell, etc.) are not yet wired up.

**Windows:** the interactive shell layer is bash/zsh/fish-only. Run agent-sh inside **WSL** for the full experience. Native Windows (cmd.exe / PowerShell) is not supported as the host shell, though headless / library / ACP-bridge usage may work — file an issue if you hit a gap.

Tip — add a shell alias:

```bash
alias ash="agent-sh"
```

Once installed, pick a backend below.

### Option A: Use the built-in agent (ash) — recommended

`ash` is agent-sh's own lightweight agent, and the path most users should start with: it shares its tool surface with the rest of the system, so extensions you install (new tools, content transforms, slash commands, themes) compose with it directly. It works with any OpenAI-compatible API — pick one of the zero-config paths below, no settings file needed. The built-in providers (openrouter, openai, openai-compatible, deepseek) register on startup; ash activates the first one with a usable key.

**Quickest path** — store a key once via the auth subcommand:

```bash
agent-sh auth login          # picks a provider interactively
agent-sh                     # launches with the saved key
```

Keys are written to `~/.agent-sh/keys.json` (chmod 0600). Resolution order is `settings.json` → `keys.json` → env var, so an env var or settings entry will still win when present. `auth login` also accepts any provider you declare under `providers` in `settings.json` — useful for custom OpenAI-compatible endpoints where the URL is committable but the key shouldn't be.

Or export the env var directly:

**Hosted models via OpenRouter** (300+ models, one key):

```bash
export OPENROUTER_API_KEY=sk-or-...
agent-sh
```

**OpenAI:**

```bash
export OPENAI_API_KEY=sk-...
agent-sh
```

**DeepSeek:**

```bash
export DEEPSEEK_API_KEY=sk-...
agent-sh
```

**Local models** (Ollama, llama.cpp server, LM Studio, vLLM — anything OpenAI-compatible):

```bash
export OPENAI_BASE_URL=http://localhost:11434/v1    # point at your server
agent-sh
```

Set `OPENAI_API_KEY` too if your server requires auth.

Once running, switch models at any time with `/model <name>` (tab-completes; selection persists across sessions).

For richer configuration (multiple providers, extensions), run `agent-sh init` to scaffold `~/.agent-sh/settings.json` with copy-pasteable examples. See the [Usage Guide](docs/usage.md) for the full list of supported providers.

`ash` is designed to be extended. Extensions can add tools, content transforms (e.g. render LaTeX or Mermaid), themes, slash commands, or new input modes — see [Extensions](docs/extensions.md) for the full surface.

### Option B: Bring your own coding agent

If you already use pi, claude-code, or opencode, agent-sh can host it as the backend instead — see [Bring your own agent](#bring-your-own-agent) just below for the full setup and the trade-offs.

## Bring your own agent

The built-in agent (`ash`) is the default, but agent-sh can host a different coding agent as its backend — same terminal, same `>` entry point, same shell-context wiring. Three bridges ship in the box:

- **[pi-bridge](examples/extensions/pi-bridge/)** — runs [pi](https://github.com/badlogic/pi-mono) (`@mariozechner/pi-coding-agent`) in-process. Pi brings its own models, tools, and `~/.pi/agent/settings.json`.

  ```bash
  agent-sh install pi-bridge
  agent-sh --backend pi
  ```

- **[claude-code-bridge](examples/extensions/claude-code-bridge/)** — runs claude-code (the official [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)) in-process. Uses claude-code's own `Read`/`Edit`/`Write`/`Bash`/`Glob`/`Grep` tools.

  ```bash
  agent-sh install claude-code-bridge
  agent-sh --backend claude-code
  ```

- **[opencode-bridge](examples/extensions/opencode-bridge/)** — runs [opencode](https://opencode.ai/) in-process via `@opencode-ai/sdk`. Uses opencode's tools, models, and `opencode auth login` credentials.

  ```bash
  agent-sh install opencode-bridge
  agent-sh --backend opencode
  ```

All three bridges receive agent-sh's per-query shell context (`<shell_events>`) and follow the PTY-tracked cwd, so the hosted agent sees what you ran and where you are. Switching at runtime with `/backend <name>` persists the choice across sessions automatically; the `--backend` flag above is per-session only.

**Caveat:** pi, claude-code, and opencode each manage their own tool surfaces, so agent-sh extensions that register tools (or skills, instructions, etc.) for the built-in `ash` agent generally won't be visible to a hosted backend. Frontend extensions (themes, content transforms, slash commands, the TUI renderer) keep working — only the agent-side capabilities differ. Use the bridges when you want that agent's toolset; stay on `ash` when you want agent-sh's extension ecosystem.

## Documentation

Start with **Usage** to get running, then **Architecture** for the mental model.

1. [Usage Guide](docs/usage.md) — install, run, configure providers and models
2. [Architecture](docs/architecture.md) — pure kernel + extensions, the shell ↔ agent boundary
3. [The Built-in Agent: ash](docs/agent.md) — query flow, tools, system prompt, model switching
4. [Context Management](docs/context-management.md) — shell-output spill, three-tier conversation compaction, recall APIs
5. [Extensions](docs/extensions.md) — event bus, content transforms, custom agent backends, theming
6. [TUI Composition](docs/tui-composition.md) — compositor, render surfaces, stream routing
7. [Library Usage](docs/library.md) — embedding agent-sh in your own apps
8. [Troubleshooting](docs/troubleshooting.md) — common errors and debug mode

## Development

```bash
git clone https://github.com/guanyilun/agent-sh.git
cd agent-sh
npm install
npm run build
npm start
```

## License

MIT
