# Architecture

agent-sh is a composable agent runtime: a pure kernel that any frontend can drive and any agent backend can plug into, over one shared extension layer. Frontends and backends are both bus-driven components that self-wire to events — the bundled shell is just one frontend among several.

## Design Philosophy: Pure Kernel + Everything Is an Extension

The core (`createCore()`) is a frontend-agnostic kernel — it wires up the EventBus, HandlerRegistry, and Compositor with zero knowledge of terminals, PTYs, LLMs, shells, or rendering. **The core has no agent, no LLM client, and no shell coupling.** The built-in agent backend, shell tracking, provider management, TUI rendering, and all other features are loaded as extensions.

```
createCore() — pure kernel:
  │     EventBus          — typed pub/sub + transform pipelines
  │     HandlerRegistry   — named function registry (define/advise/call)
  │     Compositor        — routes named render streams to surfaces
  │     Multi-backend     — coordinates which agent backend is active
  │     Default `cwd` handler returning `process.cwd()`
  │
index.ts — interactive terminal frontend:
  │     Shell             — PTY lifecycle (delegates to InputHandler + OutputParser)
  │
  ├── Agent host (always activated via activateAgent(ctx) before built-ins load):
  │     ash backend       — provider resolution, LlmClient, lazy AgentLoop
  │     core tools        — bash/read/write/edit/grep/glob/ls/list_skills registered at activate time
  │     built-in providers — openrouter, openai, openai-compatible, deepseek (unconditional)
  │
  ├── Backend registry (owned by core; backends register via `agent:register-backend`):
  │     core.activateBackend() — picks the named/persisted/first backend and calls its start()
  │
  ├── Built-in extensions (loaded via declarative manifest, individually disableable):
  │     shell-context     — PTY exchange tracking, cwd advisor, <cwd>/<shell_events> producer
  │     tui-renderer      — markdown rendering, inline diffs, thinking display, spinner
  │     slash-commands    — /help, /model, /backend, /thinking, /compact, /context, /reload
  │     file-autocomplete — @ file path completion
  │
  ├── Shared utilities:
  │     palette           — semantic color system (accent, success, warning, error, muted)
  │     diff-renderer     — syntax-highlighted diffs (split/unified/summary)
  │     box-frame         — bordered TUI panels
  │     tool-display      — width-adaptive tool call rendering + pure spinner
  │     output-writer     — OutputWriter interface (StdoutWriter, BufferWriter for tests)
  │     stream-transform  — content block transforms for response pipeline
  │
  └── User extensions (opt-in, loaded from -e flag / settings.json / extensions dir):
        e.g. overlay-agent, interactive-prompts, solarized-theme, latex-images, peer-mesh
```

All components communicate exclusively through typed bus events. The backend has no reference to Shell — it emits lifecycle events and the TUI subscribes. Input flows the same way: any frontend emits `agent:submit` and the backend handles it.

Built-in extensions are loaded from a declarative manifest and can be individually disabled via the `disabledBuiltins` setting in `~/.agent-sh/settings.json`. This means even the built-in agent can be disabled (e.g., for users who only use extension backends like Claude Code).

**The core works without any frontend.** See [Library](library.md) for embedding agent-sh in your own apps.

## How It Works

1. agent-sh spawns a real PTY running your shell (zsh or bash, with your full rc config) and sets up raw stdin passthrough
2. Built-in extensions load (including the agent backend, which registers via `agent:register-backend`), then user extensions
3. `activateBackend()` wires the chosen backend to bus events
4. All keyboard input goes directly to the PTY — zero latency, full terminal compatibility
5. When you type `>` at the start of a line, agent-sh intercepts and enters agent input mode
6. On Enter, the query is emitted as `agent:submit` and the active backend decides which tools to use
7. The backend handles the query — streaming LLM responses, executing tools, emitting events. Read-only tools run in parallel; permission-requiring tools run sequentially.
8. The TUI renderer extension renders streamed content inline (markdown, diffs, tool calls with tree-style grouping)
9. When the backend finishes (`agent:processing-done`), normal shell operation resumes

## Shell ↔ Agent Boundary

The shell and the agent are **separate worlds** by default. The PTY runs your real shell; the agent runs its tools in isolated child processes. A `cd` by the agent's `bash` tool doesn't change your shell's cwd.

### Command-boundary detection

agent-sh injects three invisible OSC sequences into its inner shell — `\e]9999;id=<tag>;PROMPT\a` (precmd), `\e]9997;id=<tag>;<cmd>\a` (preexec), `\e]9998;id=<tag>;READY\a` (prompt rendered). `<tag>` is the process's `instanceId`. The OutputParser reacts only to its own tag; markers with a different tag (or none) are treated as opaque foreground output. That's what keeps a nested agent-sh — for example, an `ash` launched inside an SSH session — from cross-triggering the outer instance's command lifecycle.

The connection between them is **context**: each query includes shell context (recent commands, output, cwd). The agent sees what you've been doing but can't touch your shell state.

Extensions can cross this boundary using `shell:exec-request`. The core event bus makes this easy to wire up — an extension just registers a tool that emits the event and returns the result. We don't include a PTY tool as built-in because the right behavior depends on user preference (confirmation prompts? output capture? restricted commands?). See `examples/extensions/user-shell.ts` for a ready-made implementation.

The pattern works like this:

```
agent calls user_shell({ command: "cd src" })
  → bus.emitPipeAsync("shell:exec-request", { command })
    → Shell writes command to PTY
      → PTY executes in user's real shell
        → shell:command-done fires with output
          → result returned to agent
```

## Agent Backend

The agent backend is a bus-driven component that registers via `agent:register-backend`. The core's multi-backend coordinator manages which backend is active — it has no knowledge of any specific backend's internals.

### Built-in backend: ash

The default backend is **ash**, registered from the agent host (`src/agent/index.ts`) when `activateAgent(ctx)` runs. It resolves LLM providers from registered catalogs + settings overlay, configures an `LlmClient`, and registers itself with the core's backend registry by emitting `agent:register-backend`. The `AgentLoop` that drives tool calls is constructed lazily — only when ash's `start()` runs (on `activateBackend("ash")`). See [The Built-in Agent: ash](agent.md) for the full guide.

The agent host also defines an `llm:invoke` handler that backs the `ctx.agent.llm` facade, so any extension can call `ctx.agent.llm.ask(...)` or `ctx.agent.llm.session(...)` without knowing which backend is active. Backends with no LLM leave `ctx.agent.llm.available` false.

### Extension Backends

Extensions can register alternative backends by emitting `agent:register-backend` during activation — this is the same mechanism the built-in agent uses. See [Extensions: Custom Agent Backends](extensions.md#custom-agent-backends) for the full protocol and a working example.

All backends emit the same bus events. The TUI, extensions, and library consumers don't know which backend is active.

## Key Extension Points

The extension system provides several composable primitives for customizing agent-sh. Each is documented in detail in the [Extensions](extensions.md) guide:

- **[Event Bus](extensions.md#event-bus)** — typed pub/sub (`on`/`emit`), synchronous transform chains (`onPipe`/`emitPipe`), async transform chains (`onPipeAsync`/`emitPipeAsync`), and transform-then-notify (`emitTransform`)
- **[Custom Agent Backends](extensions.md#custom-agent-backends)** — replace the entire agent backend via `agent:register-backend`
- **[Named Handlers](extensions.md#named-handlers-advice-system)** — `define`/`advise`/`call` registry for wrapping processing steps (e.g. code block rendering)
- **[Content Transform Pipeline](extensions.md#content-transform-pipeline)** — typed content blocks (`text`, `code-block`, `image`, `raw`) flow through parsers and post-transforms before rendering
- **[Custom Input Modes](extensions.md#custom-input-modes)** — register trigger characters (`?`, `>`, etc.) with custom `onSubmit` handlers
- **[Terminal Buffer & Floating Panel](extensions.md#terminal-buffer--floating-panel)** — headless xterm.js terminal mirror + composited overlay with handler-based rendering customization
- **[Theming](extensions.md#theming)** — semantic color palette overrides via `setPalette()`

## Project Structure

```
agent-sh/
├── src/
│   ├── core/                 # Substrate kernel — no LLM, no agent, no shell
│   │   ├── index.ts          # createCore(), backend registry, extensionContext()
│   │   ├── types.ts          # CoreContext, CoreConfig
│   │   ├── event-bus.ts      # Typed EventBus: emit/on, emitPipe, emitPipeAsync, emitTransform
│   │   ├── settings.ts       # User settings (~/.agent-sh/settings.json)
│   │   └── extension-loader.ts # Extension loading (-e, settings.json, extensions dir)
│   │
│   ├── cli/                  # CLI entry + subcommands (install, init, auth)
│   │   ├── index.ts          # Interactive terminal entry point
│   │   ├── subcommands.ts, install.ts, init.ts
│   │   └── auth/             # Provider API key management
│   │
│   ├── shell/                # Shell host — TUI frontend, PTY, compositor, theming
│   │   ├── index.ts          # registerShellHandlers/activateShell — attaches ctx.shell
│   │   ├── events.ts         # BusEvents augmentation (shell:*, input:*, compositor:*, autocomplete:request)
│   │   ├── host-types.ts     # ShellSurface, ShellContext, ExtensionContext, AppConfig
│   │   ├── shell.ts          # PTY lifecycle + wiring (InputHandler + OutputParser)
│   │   ├── shell-context.ts  # Shell exchange tracking, cwd advisor, <shell_events>
│   │   ├── tui-renderer.ts   # Main renderer — writes to compositor streams
│   │   ├── input-handler.ts  # Keyboard input, agent mode, bus-driven autocomplete
│   │   ├── output-parser.ts  # OSC parsing, command boundary detection
│   │   └── tui-input-view.ts # Input rendering + line editor integration
│   │
│   ├── agent/                # Agent host — ash backend, providers, tools, skills
│   │   ├── index.ts          # activateAgent — attaches ctx.agent, registers core tools + ash backend
│   │   ├── events.ts         # BusEvents augmentation (agent:providers, agent:modes-changed, ...)
│   │   ├── host-types.ts     # AgentSurface, AgentContext, ProviderRegistration, AgentMode
│   │   ├── types.ts          # AgentBackend, ToolDefinition, ToolResult
│   │   ├── agent-loop.ts     # ash AgentLoop (constructed lazily in start())
│   │   ├── llm-client.ts, llm-facade.ts  # ash LLM transport + ctx.agent.llm facade
│   │   ├── providers/        # openai, openrouter, deepseek, openai-compatible
│   │   ├── token-budget.ts   # Shared constants (RESPONSE_RESERVE, DEFAULT_CONTEXT_WINDOW)
│   │   ├── tool-registry.ts, tool-protocol.ts
│   │   ├── conversation-state.ts  # Messages + eager nucleation + priority compaction + recall
│   │   ├── nuclear-form.ts, history-file.ts, system-prompt.ts
│   │   ├── skills.ts, subagent.ts
│   │   └── tools/            # Built-in tool implementations (bash, read/write/edit, grep, glob, ls, ...)
│   │
│   ├── extensions/           # Cross-cutting built-ins (loaded via manifest)
│   │   ├── index.ts          # Declarative manifest + loader
│   │   ├── slash-commands/   # /reload, /quit, command dispatch; events.ts ships command:* events
│   │   └── file-autocomplete.ts
│   │
│   └── utils/                # Shared primitives
│       ├── handler-registry.ts # Named function registry (define/advise/call)
│       ├── compositor.ts       # Routes named render streams to surfaces
│       ├── terminal-buffer.ts  # Headless xterm.js mirror of the terminal
│       ├── floating-panel.ts   # Composited floating overlay
│       ├── executor.ts         # Isolated child process execution
│       ├── shell-output-spill.ts # Session-tempfile spill for long shell outputs
│       ├── palette.ts, ansi.ts, diff.ts, diff-renderer.ts
│       └── (markdown, line-editor, stream-transform, ...)
│
├── examples/                 # Example extensions and agent integrations
│   └── extensions/
│       ├── overlay-agent.ts     # Ctrl+\ floating overlay agent
│       ├── interactive-prompts.ts # Permission prompts (opt-in safety)
│       ├── peer-mesh.ts         # Cross-instance communication
│       ├── terminal-buffer.ts   # Headless xterm.js terminal mirror extension
│       ├── tmux-pane.ts         # Tmux side pane output/interactive modes
│       ├── web-access.ts        # Web search and content extraction
│       ├── user-shell.ts        # Run commands in the live PTY
│       ├── questionnaire.ts     # Interactive question prompts
│       ├── subagents.ts         # Subagent orchestration
│       ├── solarized-theme.ts   # Theme example
│       ├── secret-guard.ts      # Secret redaction
│       ├── latex-images.ts      # LaTeX equation rendering
│       ├── ollama.ts            # Ollama provider (local + cloud)
│       ├── claude-code-bridge/  # Claude Code SDK backend
│       ├── pi-bridge/           # Pi agent backend
│       ├── ash-mcp-bridge/      # MCP server bridge
│       └── ash-acp-bridge/      # ACP server (headless core)
├── docs/                     # Documentation
├── package.json
└── tsconfig.json
```
