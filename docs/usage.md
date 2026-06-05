# Usage Guide

## Running agent-sh

The simplest way to run agent-sh — just provide an API key:

```bash
# DeepSeek is a built-in provider — set the key and go (defaults to deepseek-v4-flash)
DEEPSEEK_API_KEY="your-key" agent-sh

# Any OpenAI-compatible endpoint via CLI flags (e.g. a local Ollama server)
agent-sh --api-key "your-key" --base-url http://localhost:11434/v1 --model gemma4

# Using npx
DEEPSEEK_API_KEY="your-key" npx agent-sh --model deepseek-v4-flash
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
DEBUG=1 DEEPSEEK_API_KEY="$KEY" agent-sh
```

### Subcommands

```bash
agent-sh init                   # scaffold ~/.agent-sh/ (settings.json + settings.example.json, extensions/ dir)
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
      "defaultModel": "gemma4",
      "models": ["gemma4"]
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

### DeepSeek

```bash
export DEEPSEEK_API_KEY="sk-..."
agent-sh   # defaults to deepseek-v4-flash
```

### OpenAI

```bash
export OPENAI_API_KEY="sk-..."
agent-sh --model gpt-5.4
# or: agent-sh --model gpt-5.4-mini
```

### Ollama (Local)

```bash
# No API key needed — Ollama doesn't require authentication
agent-sh --api-key dummy --base-url http://localhost:11434/v1 --model gemma4
```

### OpenRouter

```bash
agent-sh --api-key "$OPENROUTER_KEY" \
  --base-url https://openrouter.ai/api/v1 \
  --model deepseek/deepseek-v4-flash
```

### Together AI

```bash
agent-sh --api-key "$TOGETHER_KEY" \
  --base-url https://api.together.xyz/v1 \
  --model deepseek-ai/DeepSeek-V3
```

### Groq

```bash
agent-sh --api-key "$GROQ_KEY" \
  --base-url https://api.groq.com/openai/v1 \
  --model deepseek-r1-distill-llama-70b
```

### LM Studio

```bash
agent-sh --api-key dummy \
  --base-url http://localhost:1234/v1 \
  --model mimo
```

### vLLM

```bash
agent-sh --api-key dummy \
  --base-url http://localhost:8000/v1 \
  --model deepseek-v4-flash
```

## Using agent-sh as Your Default Shell

Add to the end of your `~/.zshrc` or `~/.bashrc`:

```bash
if [[ -z "$AGENT_SH" && $- == *i* && -t 0 ]]; then
  exec agent-sh   # uses DEEPSEEK_API_KEY from your env (deepseek-v4-flash)
fi
```

The `AGENT_SH` guard prevents infinite recursion. The checks ensure it only launches for interactive terminal sessions.

## Configuration

agent-sh stores settings and query history in `~/.agent-sh/`. Configure via `~/.agent-sh/settings.json` — all fields are optional with sensible defaults.

### Provider Profiles

Instead of passing `--api-key` and `--base-url` every time, define named providers in settings.json:

```json
{
  "defaultProvider": "deepseek",
  "providers": {
    "deepseek": {
      "apiKey": "$DEEPSEEK_API_KEY",
      "defaultModel": "deepseek-v4-flash",
      "models": ["deepseek-v4-flash", "deepseek-v4-pro"]
    },
    "ollama": {
      "apiKey": "not-needed",
      "baseURL": "http://localhost:11434/v1",
      "defaultModel": "gemma4",
      "models": [
        "mimo",
        { "id": "gemma4", "contextWindow": 128000, "modalities": ["text", "image"] }
      ]
    },
    "openrouter": {
      "apiKey": "$OPENROUTER_KEY",
      "baseURL": "https://openrouter.ai/api/v1",
      "defaultModel": "deepseek/deepseek-v4-flash",
      "models": [
        { "id": "deepseek/deepseek-v4-flash", "contextWindow": 1000000, "reasoning": true },
        { "id": "deepseek/deepseek-v4-pro",   "contextWindow": 1048576, "reasoning": true }
      ]
    }
  }
}
```

Then just run:

```bash
agent-sh                          # uses defaultProvider (deepseek)
agent-sh --provider ollama        # use a specific provider
agent-sh --provider ollama --model gemma4  # override the default model
```

The `apiKey` field supports `$ENV_VAR` and `${ENV_VAR}` syntax — variables are expanded at runtime, so you don't store secrets in the file.

### Declaring model capabilities

Entries in a provider's `models` list can be plain strings (just the id) or objects that declare what the model can do. agent-sh uses these to size its context budget, cap output, route reasoning, and enable image input. Every field except `id` is optional.

```json
"models": [
  "deepseek-v4-flash",
  {
    "id": "gemma4",
    "contextWindow": 128000,
    "maxTokens": 8192,
    "modalities": ["text", "image"]
  },
  { "id": "mimo",            "reasoning": true },
  { "id": "deepseek-v4-pro", "contextWindow": 1000000, "reasoning": true, "echoReasoning": true }
]
```

| Field | Type | Default | Effect |
|---|---|---|---|
| `id` | `string` | — | Model identifier sent to the API (required). |
| `contextWindow` | `number` | provider-level `contextWindow`, else `60000` | Total token budget. Drives the `/context` display and the `autoCompactThreshold` auto-compaction trigger. |
| `maxTokens` | `number` | 40% of this model's `contextWindow` capped at `65536`, else `65536` | Max output (completion) tokens requested per turn. |
| `reasoning` | `boolean` | `false` | Marks the model as thinking-capable, so `/thinking` levels apply to it. |
| `modalities` | `("text" \| "image")[]` | `["text"]` | Input modalities. Include `"image"` to let the agent read image files (PNG/JPEG/GIF/WebP) with `read_file`; without it, attached images are dropped before the request. |
| `echoReasoning` | `boolean` | `false` | Echo `reasoning_content` back on assistant turns. Required by DeepSeek's reasoner; leave off otherwise (leaky proxies may forward it to the model as malformed input). |

A plain-string entry inherits the provider-level values and the defaults above. These provider-level fields apply to every model unless a per-model entry overrides them:

| Provider field | Effect |
|---|---|
| `contextWindow` | Fallback context window for models that don't declare their own. |
| `reasoningShape` | Borrow another registered provider's reasoning-request shape by id (e.g. `"openrouter"`). Defaults to the OpenAI-compatible shape. |
| `echoReasoningPatterns` | Case-insensitive regex sources matched against model ids; a match defaults that model to `echoReasoning: true` (a per-model `echoReasoning` still wins). |

If neither level declares a `contextWindow`, agent-sh falls back to a conservative 60k-token budget.

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
| `historyMaxBytes` | `104857600` | Max size of `~/.agent-sh/history` before front-truncation (100MB) |
| `historyStartupEntries` | `100` | Prior history entries injected as `[Prior session history]` preamble on launch |
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
- **Model** — current model with provider in brackets (e.g. `deepseek-v4-flash [deepseek]`)
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
| `/history [on\|off\|status]` | Pause/resume cross-session history writes for this session (no cache invalidation) |
| `/reload` | Reload user extensions from `~/.agent-sh/extensions/` |

See [Context Management](context-management.md) for how `/compact` and `/context` work, and [Extensions: Custom Agent Backends](extensions.md#custom-agent-backends) for `/backend`.
