# agent-sh

A real shell with an AI agent one keystroke away.

[![npm version](https://img.shields.io/npm/v/agent-sh.svg)](https://www.npmjs.com/package/agent-sh)
[![license](https://img.shields.io/npm/l/agent-sh.svg)](https://github.com/guanyilun/agent-sh/blob/main/LICENSE)

![demo](assets/demo.gif)

I live in my terminal. A lot of the time I'm not coding — I'm deploying something, poking at a failing `rsync`, figuring out why `docker build` won't start, fixing a one-liner. And very often I need an AI agent to help. For serious coding work I use Claude Code. But for this other stuff, spinning up a full coding agent is overkill — and I got tired of copy-pasting errors into a chat window every time.

So I built agent-sh. Under the hood it's a normal shell on top of node-pty — your rc config, your aliases, vim and tmux all just work. But at the start of any line, type `>` and you're talking to a small agent that already sees your cwd, your last command, and its output. Nothing to set up, no project to explain.

```
~ $ ls -la                       # real shell command
~ $ cd ../tests && npm test      # real cd, env, aliases — all just work
~ $ vim file.ts                  # opens vim in the same PTY
~ $ > explain the last error     # agent investigates using its own tools
~ $ > draft a commit message     # agent reads your diff and shell history
```

I still use Claude Code and pi for serious coding work — this doesn't replace them. But for the quick stuff in the terminal, I reach for agent-sh almost every day now. The built-in agent is lightweight and good enough for most of what I throw at it, and when it isn't, bridge extensions let you plug [Claude Code](examples/extensions/claude-code-bridge/) or [pi](examples/extensions/pi-bridge/) in as the backend.

## Quick Start

Install the latest from GitHub (recommended — development moves faster than npm releases):

```bash
npm install -g github:guanyilun/agent-sh
```

Or the last published npm release:

```bash
npm install -g agent-sh
```

Pick one of the zero-config paths below — no settings file needed. agent-sh auto-activates a built-in provider when it sees a known key.

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

**Local models** (Ollama, llama.cpp server, LM Studio, vLLM — anything OpenAI-compatible):

```bash
export OPENAI_API_KEY=ollama                        # any value; dummy is fine
export OPENAI_BASE_URL=http://localhost:11434/v1    # point at your server
agent-sh
```

Once running, switch models at any time with `/model <name>` (tab-completes; selection persists across sessions).

For richer configuration (multiple providers, extensions), run `agent-sh init` to scaffold `~/.agent-sh/settings.json` with copy-pasteable examples. See the [Usage Guide](docs/usage.md) for the full list of supported providers.

Tip — add a shell alias:

```bash
alias ash="agent-sh"
```

Requires Node.js 18+. Currently supports **bash** and **zsh**; other shells (fish, nushell, etc.) are not yet wired up.

## Key Features

**Real terminal, zero compromise.** Full PTY with your shell config, aliases, and environment. Shell starts instantly — the agent connects asynchronously in the background.

**One entry point, smart tool selection.** Type `>` and agent-sh figures out how to help. Scratchpad tools (`bash`, `read_file`, `grep`, `glob`) for investigation. Extensions add capabilities like running commands in your live shell. No modes to pick — the agent reasons about which tools to use based on your intent.

**Context that just works.** Every query includes your cwd, recent commands, and their output. Run a failing test, type `> fix this`, and agent-sh knows exactly what happened. Context management works like shell history — continuous, persistent across restarts, no sessions to manage. See [Context Management](docs/context-management.md).

**Any LLM, any backend.** agent-sh works with any OpenAI-compatible API out of the box. Define multiple providers in settings and switch models at runtime with `/model <name>`. Or swap in a completely different agent — [Claude Code](examples/extensions/claude-code-bridge/) and [pi](examples/extensions/pi-bridge/) run as drop-in backend extensions.

**Extensible by design.** The entire system is built on a typed event bus. Extensions can add custom input modes, content transforms (render LaTeX as images, Mermaid as diagrams), themes, slash commands, or replace the agent backend entirely. The built-in TUI renderer is itself just an extension.

**Embeddable as a library.** The core is a headless kernel — `import { createCore } from "agent-sh"` to build WebSocket servers, REST APIs, Electron apps, or test harnesses. No terminal required.

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
