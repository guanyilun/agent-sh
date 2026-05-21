# Usage Guide

## Running agent-sh

The simplest way to run agent-sh — just provide an API key and model:

```bash
# Using environment variables
OPENAI_API_KEY="your-key" agent-sh --model gpt-4o

# Using CLI flags
agent-sh --api-key "your-key" --base-url http://localhost:11434/v1 --model llama3

# Using npx
npx agent-sh --api-key "$KEY" --model gpt-4o
```

Environment variables `OPENAI_API_KEY` and `OPENAI_BASE_URL` are supported as alternatives to CLI flags.

### Other Options

```bash
# Use a different shell
agent-sh --shell /bin/zsh

# Launch a non-default agent backend (per-session override; doesn't touch settings)
agent-sh --backend pi

# Development mode (no build step)
npm run dev

# Debug mode
DEBUG=1 agent-sh --api-key "$KEY" --model gpt-4o
```

### Subcommands

```bash
agent-sh init                   # scaffold ~/.agent-sh/ (settings, examples, AGENTS.md)
agent-sh install <name>         # install a bundled extension (e.g. agent-sh install pi-bridge)
agent-sh install ./path/to/ext  # install from a local path
agent-sh uninstall <name>       # remove an installed extension
agent-sh list                   # show extensions discovered from ~/.agent-sh/extensions/ and settings.json
agent-sh auth login [provider]  # store an API key; provider list is discovered from built-ins, settings.json, and any extension that calls ctx.agent.providers.register
agent-sh auth logout <provider> # remove a stored key
agent-sh auth list              # show configured providers and their key source ("(no auth required)" for local-daemon providers registered with noAuth: true)
```

Keys stored via `auth` live in `~/.agent-sh/keys.json` (chmod 0600). Resolution order when launching is `settings.json` → `keys.json` → env var, so explicit configuration always wins over the auth store.

Any provider you declare under `providers` in `settings.json` is also accepted by `auth login <id>`. This lets you keep custom endpoints in version control (id, baseURL, model list) while the key stays in `keys.json` out of the committable file:

```json
{
  "providers": {
    "my-llama": {
      "baseURL": "http://localhost:8000/v1",
      "defaultModel": "llama-3.1-70b",
      "models": ["llama-3.1-70b"]
    }
  }
}
```

```bash
agent-sh auth login my-llama   # prompts for the key, saves to keys.json
```

`auth login <id>` also accepts ids it doesn't recognize (with a warning). This lets extensions that register their own provider at runtime tell users to run `agent-sh auth login <their-id>` — the key sits in `keys.json` until the extension loads and claims it. Such entries appear in `auth list` tagged `unattached`.

`install` accepts a bundled-extension name (see `agent-sh install` with no argument for the list), a `file:`/`./`/absolute path, or — once implemented — `npm:<pkg>` and `github:<user>/<repo>` specs.

## Updating

To pick up the latest changes, re-run the install command — npm replaces the global install in place. No uninstall step needed.

```bash
npm install -g agent-sh@latest             # latest npm release (recommended)
```

For unreleased changes on `main`, use the clone-and-link flow from the [Quick Start](../README.md#quick-start) — `npm install -g github:...` builds on your machine and can fail if the TypeScript toolchain doesn't extract cleanly.

## Provider Examples

agent-sh works with any OpenAI-compatible API. Here are common configurations:

### OpenAI

```bash
export OPENAI_API_KEY="sk-..."
agent-sh --model gpt-4o
# or: agent-sh --model gpt-4o-mini
```

### DeepSeek

```bash
export DEEPSEEK_API_KEY="sk-..."
agent-sh
```

### Ollama (Local)

```bash
# No API key needed — Ollama doesn't require authentication
agent-sh --api-key dummy --base-url http://localhost:11434/v1 --model llama3
```

### OpenRouter

```bash
agent-sh --api-key "$OPENROUTER_KEY" \
  --base-url https://openrouter.ai/api/v1 \
  --model anthropic/claude-sonnet-4-20250514
```

### Together AI

```bash
agent-sh --api-key "$TOGETHER_KEY" \
  --base-url https://api.together.xyz/v1 \
  --model meta-llama/Llama-3-70b-chat-hf
```

### Groq

```bash
agent-sh --api-key "$GROQ_KEY" \
  --base-url https://api.groq.com/openai/v1 \
  --model llama-3.3-70b-versatile
```

### LM Studio

```bash
agent-sh --api-key dummy \
  --base-url http://localhost:1234/v1 \
  --model local-model
```

### vLLM

```bash
agent-sh --api-key dummy \
  --base-url http://localhost:8000/v1 \
  --model your-model
```

## Using agent-sh as Your Default Shell

Add to the end of your `~/.zshrc` or `~/.bashrc`:

```bash
if [[ -z "$AGENT_SH" && $- == *i* && -t 0 ]]; then
  exec agent-sh --api-key "$OPENAI_API_KEY" --model gpt-4o
fi
```

The `AGENT_SH` guard prevents infinite recursion. The checks ensure it only launches for interactive terminal sessions.

## Configuration

agent-sh stores settings and query history in `~/.agent-sh/`. Configure via `~/.agent-sh/settings.json` — all fields are optional with sensible defaults.

### Provider Profiles

Instead of passing `--api-key` and `--base-url` every time, define named providers in settings.json:

```json
{
  "defaultProvider": "openai",
  "providers": {
    "openai": {
      "apiKey": "$OPENAI_API_KEY",
      "defaultModel": "gpt-4o",
      "models": ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo"],
      "contextWindow": 128000
    },
    "ollama": {
      "apiKey": "not-needed",
      "baseURL": "http://localhost:11434/v1",
      "defaultModel": "llama3",
      "models": ["llama3", "mistral", "codellama"]
    },
    "openrouter": {
      "apiKey": "$OPENROUTER_KEY",
      "baseURL": "https://openrouter.ai/api/v1",
      "defaultModel": "anthropic/claude-sonnet-4.5",
      "models": [
        { "id": "anthropic/claude-sonnet-4.5", "contextWindow": 200000, "reasoning": true },
        { "id": "google/gemini-2.5-pro",       "contextWindow": 1000000 }
      ]
    }
  }
}
```

Then just run:

```bash
agent-sh                          # uses defaultProvider
agent-sh --provider ollama        # use a specific provider
agent-sh --provider openai --model gpt-4-turbo  # override the default model
```

The `apiKey` field supports `$ENV_VAR` and `${ENV_VAR}` syntax — variables are expanded at runtime, so you don't store secrets in the file.

### Declaring the context window

agent-sh adapts its auto-compaction trigger to the model's context window. There are two places to declare it:

- **Provider-level `contextWindow`** — applies to every model in that provider unless a more specific value is set.
- **Per-model `contextWindow`** (inside an entry of `models`) — overrides the provider-level value for a specific model, and also lets you tag reasoning-capable models via `reasoning: true`.

If neither is set, agent-sh falls back to a conservative 60k-token default.

Entries in `models` can be plain strings (just the model id, uses the provider-level `contextWindow`) or objects:

```json
"models": [
  "gpt-4o-mini",
  { "id": "gpt-4o",    "contextWindow": 128000 },
  { "id": "o1-preview", "contextWindow": 128000, "reasoning": true }
]
```

### Switching models at runtime

- **`/model`** — show the current model
- **`/model <name>`** — switch to a specific model (may cross providers; API key and base URL are reconfigured automatically)

Switching mid-conversation preserves your conversation state — only the LLM endpoint changes.

### CLI Flags

| Flag | Environment Variable | Description |
|---|---|---|
| `--provider <name>` | — | Use a named provider from settings.json |
| `--model <name>` | — | Model name (overrides provider default) |
| `--api-key <key>` | `OPENAI_API_KEY` | API key for OpenAI-compatible API |
| `--base-url <url>` | `OPENAI_BASE_URL` | Base URL for API endpoint |
| `--shell <path>` | `SHELL` | Shell to use (default: `/bin/bash`) |
| `--backend <name>` | — | Agent backend to launch (e.g. `ash`, `pi`); per-session override of `settings.defaultBackend`, does not persist. Errors out if the named backend isn't registered. |
| `-e, --extensions` | — | Extensions to load (comma-separated, repeatable) |

**Precedence** (highest to lowest): CLI flags → environment variables → provider profile in settings.json → defaults.

### General Settings

| Setting | Default | Description |
|---|---|---|
| `defaultProvider` | — | Which provider to use when no `--provider` flag is given |
| `defaultBackend` | `"ash"` | Which agent backend to activate. Set to an extension backend name (e.g. `"claude-code"`, `"pi"`) to use it by default |
| `extensions` | `[]` | Extensions to load (npm packages or file paths) |
| `historySize` | `500` | Max agent query history entries (persisted across sessions) |
| `shellTruncateThreshold` | `20` | Shell output lines before spill-to-tempfile |
| `shellHeadLines` / `shellTailLines` | `10` / `10` | Lines kept from start/end when output is spilled |
| `autoCompactThreshold` | `0.5` | Fraction of the model's context window at which conversation auto-compacts |
| `maxCommandOutputLines` | `3` | Max tool output lines shown inline in TUI |
| `readOutputMaxLines` | `10` | Max read tool output lines shown inline (0 = hidden) |
| `diffMaxLines` | `Infinity` | Max diff lines rendered in the TUI. Defaults to no limit |
| `skillPaths` | `[]` | Extra directories to scan for skills (supports `~` expansion) |
| `diagnose` | `false` | Enable the `diagnose` tool — lets the agent evaluate JS expressions against its own runtime state (introspection; agent already has bash, so this is convenience, not new capability) |
| `startupBanner` | `true` | Show the startup banner (backend / model / extensions / skills) on launch |
| `promptIndicator` | `true` | Show a subtle agent-sh indicator in the shell prompt |
| `toolMode` | `"api"` | How tools are presented to the LLM. `"api"` sends all tool schemas. `"deferred"` bundles extension tools behind a `use_extension(name, args)` meta-tool (saves prompt tokens, loses schema fidelity). `"deferred-lookup"` keeps extension schemas dormant until the model calls `load_tool(names[])` — loaded tools then become first-class on the next turn with full schemas. `"inline"` describes tools as text. |
| `disabledExtensions` | `[]` | Names of user extensions in `~/.agent-sh/extensions/` to skip when auto-discovering. Match by basename without extension for files (`"peer-mesh"` matches `peer-mesh.ts`) or by directory name for dir-style extensions (`"superash"` matches `superash/index.ts`). Avoids having to rename files to `.disabled`. |
| `disabledBuiltins` | `[]` | Names of built-in extensions to disable. |

## Startup Banner

On launch, agent-sh displays a structured startup banner showing:

- **Backend** — which agent backend is active (`ash`, `claude-code`, `pi`, etc.)
- **Model** — current model with provider in brackets (e.g. `gpt-4o [openai]`)
- **Extensions** — loaded extensions (from CLI `-e`, settings, or `~/.agent-sh/extensions/`)
- **Skills** — discovered skills (global + project)

Set `startupBanner: false` in settings to disable.

## Shell Context

The agent automatically receives structured context about your shell session with each query:

- **Current working directory** — tracked via OSC 7 escape sequences
- **Recent commands and output** — new shell activity since the last turn is wrapped as `<shell_events>` inside `<query_context>` and prepended to your query
- **Long outputs are spilled to tempfiles** — outputs over `shellTruncateThreshold` lines are written to `<tmpdir>/agent-sh-<pid>/<id>.out` at capture; the agent sees head+tail plus the path and recovers the full text via the built-in `read_file` tool

This means you can run a failing command, then type `> fix this` and the agent knows exactly what happened — including a pointer to the full output if it got truncated. See [Context Management](context-management.md) for the full design.

## Slash Commands

| Command | Description |
|---|---|
| `/help` | Show available commands |
| `/model [name]` | Show current model; with a name, switch to that model |
| `/backend [name]` | List backends, or switch to a named backend |
| `/thinking [level]` | Set reasoning effort (off, low, medium, high) |
| `/compact` | Compact conversation (free up context space) |
| `/context` | Show context budget usage (active tokens vs. budget) |
| `/reload` | Reload user extensions from `~/.agent-sh/extensions/` |

See [Context Management](context-management.md) for how `/compact` and `/context` work, and [Extensions: Custom Agent Backends](extensions.md#custom-agent-backends) for `/backend`.
