# Architecture

agent-sh is a shell with a pluggable AI backend. The shell is the product — the agent is a bus-driven component that self-wires to events.

## Design Philosophy: Headless Core + Pluggable Backends

The core (`createCore()`) is a frontend-agnostic kernel — it wires up the EventBus, ContextManager, and an AgentBackend with zero knowledge of terminals, PTYs, or rendering. The interactive terminal is one frontend built on top.

```
createCore({ apiKey, baseURL, model }) — frontend-agnostic kernel:
  │     EventBus          — typed pub/sub + transform pipelines
  │     ContextManager    — exchange recording, context assembly
  │     AgentBackend      — bus-driven, self-wiring (AgentLoop or AcpClient)
  │     LlmClient         — shared OpenAI-compat SDK wrapper (null in ACP mode)
  │
index.ts — interactive terminal frontend:
  │     Shell             — PTY lifecycle (delegates to InputHandler + OutputParser)
  │
  ├── Built-in extensions:
  │     tuiRenderer       — markdown rendering, inline diffs, thinking display, spinner
  │     slashCommands     — /help, /clear, /copy, /compact, /quit
  │     fileAutocomplete  — @ file path completion
  │     shellRecall       — shell_recall terminal interception
  │     commandSuggest    — fix suggestions on failed commands (fast-path LLM)
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
        e.g. interactive-prompts, solarized-theme, latex-images
```

All components communicate exclusively through typed bus events. The backend has no reference to Shell — it emits lifecycle events and the TUI subscribes. Input flows the same way: any frontend emits `agent:submit` and the backend handles it.

**The core works without any frontend.** This enables:

- **Library usage** — `import { createCore } from "agent-sh"` to build WebSocket servers, REST APIs, Electron apps, or test harnesses
- **Headless mode** — CI, scripting, embedding — no terminal needed
- **Alternative renderers** — web UI, logging backend, minimal TUI
- **Custom features** — add commands, autocomplete providers, tool interceptors by writing an extension

## Agent Backend

The agent backend is a bus-driven component that self-wires to events in its constructor. Core creates it and holds a reference for lifecycle only — it never calls methods on it (except `kill()`).

```
              AgentBackend (bus-driven, self-wiring)
              ├── subscribes to: agent:submit, agent:cancel-request, config:cycle
              ├── emits: agent:response-chunk, agent:tool-started, ...
              └── kill()  ← only imperative method
                         │
              ┌──────────┴──────────┐
              │                     │
         AcpClient              AgentLoop
    (subprocess, ACP proto)   (in-process, OpenAI API)
              │                     │
         Same bus events       Same bus events
              │                     │
              └──────────┬──────────┘
                         │
                    TUI / Extensions
                   (don't know, don't care)
```

### Internal Agent (AgentLoop)

The default when `--api-key` is provided. Uses the `openai` SDK to call any OpenAI-compatible API directly. The agent loop runs in-process:

- **Shared state** — reads `contextManager.getCwd()`, `.getExchanges()` directly. No bridge tools needed for cwd or history.
- **Built-in tools** — bash, read_file, write_file, edit_file, grep, glob, ls, user_shell
- **Streaming** — reasoning/thinking tokens + response text + tool calls, all via bus events
- **Fast-path features** — `LlmClient` is shared with extensions for single-shot completions (command suggestions, etc.)

### ACP Agent (AcpClient)

The alternative when `--agent <command>` is provided. Launches an external agent subprocess that speaks the [Agent Client Protocol](https://agentclientprotocol.com/). The agent brings its own tools, models, and context management.

Both backends emit the same bus events. The TUI, extensions, and library consumers don't know which backend is active.

## How It Works

1. agent-sh spawns a real PTY running your shell (zsh or bash, with your full rc config) and sets up raw stdin passthrough
2. It creates the agent backend (AgentLoop or AcpClient) which self-wires to bus events
3. All keyboard input goes directly to the PTY — zero latency, full terminal compatibility
4. When you type `?` or `>` at the start of a line, agent-sh intercepts and enters an agent input mode
5. On Enter, the query is emitted as `agent:submit` with a mode instruction (`[mode: query]` or `[mode: execute]`)
6. The backend handles the query — streaming LLM responses, executing tools, emitting events
7. The TUI renderer extension renders streamed content inline (markdown, diffs, tool calls)
8. When the backend finishes (`agent:processing-done`), normal shell operation resumes

## Shell ↔ Agent Boundary

The shell and the agent are **separate worlds** by default. The PTY runs your real shell; the agent runs its tools in isolated child processes. A `cd` by the agent's `bash` tool doesn't change your shell's cwd.

The connection between them is **context**: each query includes shell context (recent commands, output, cwd). The agent sees what you've been doing but can't touch your shell state — unless it uses `user_shell`.

### user_shell — The Bridge

For commands that *should* affect the live shell (`cd`, `export`, `source`, user-facing commands), the agent uses `user_shell`. This tool writes the command to the actual PTY via bus events:

```
agent calls user_shell({ command: "cd src" })
  → bus.emitPipeAsync("shell:exec-request", { command })
    → Shell writes command to PTY
      → PTY executes in user's real shell
        → shell:command-done fires with output
          → result returned to agent
```

With the internal agent, `user_shell` is a built-in tool. With ACP, agents discover it via MCP server or agent extensions connected to the Unix socket (`$AGENT_SH_SOCKET`).

## Input Mode System

agent-sh supports multiple input modes, each triggered by a single character at the start of an empty shell line:

| Trigger | Mode | Behavior |
|---|---|---|
| `?` | Query | Agent uses internal tools (bash, file ops). Stays in query mode after response. |
| `>` | Execute | Agent runs command in user's live shell via `user_shell`. Returns to shell after. |

Modes are registered via `input-mode:register` bus events. Extensions can add new modes — each binds a trigger character to an `onSubmit` handler that emits `agent:submit` with a mode-specific instruction.

The system prompt explains both modes to the agent. Each query includes a per-query mode instruction (e.g. `[mode: query]` or `[mode: execute]`) so the agent knows how to behave.

## EventBus

All communication between components flows through a typed EventBus. Components emit events (shell commands, agent responses, tool calls) and extensions subscribe. The bus supports four modes:

- **emit/on** — fire-and-forget notifications (e.g., `shell:command-done`)
- **emitPipe/onPipe** — synchronous transform chains (e.g., `autocomplete:request` where extensions append completion items)
- **emitPipeAsync/onPipeAsync** — async transform chains (e.g., `permission:request` where extensions prompt the user, `shell:exec-request` where Shell executes a command in the PTY)
- **emitTransform** — transform-then-notify: runs pipe listeners to transform the payload, then emits the result to `on` listeners. Used for content streams where extensions can modify data before renderers see it.

### Named Handler Registry

Separate from the event bus, a **handler registry** provides Emacs-style advice for named processing steps:

```
ctx.define("render:code-block", defaultHandler)     ← tui-renderer
ctx.advise("render:code-block", latexWrapper)        ← latex-images extension
ctx.advise("render:code-block", mermaidWrapper)      ← mermaid extension
→ Call: mermaid → latex → default (first to not call next() wins)
```

Events are for **data flow** (content streaming, notifications). Handlers are for **named processing steps** (render this code block, display this image).

### Content Transform Pipeline

Agent content streams use `emitTransform` — a two-phase emission that runs pipe listeners (transforms) first, then notifies `on` listeners (renderers) with the transformed result.

```
Backend emitTransform("agent:response-chunk", { blocks: [{ type: "text", text }] })
  │
  │ Phase 1 — onPipe transforms (nobody is special):
  │   createBlockTransform:        text → finds $$...$$ → image blocks
  │   createFencedBlockTransform:  text → finds ```...``` → code-block blocks
  │   extension onPipe:            code-block → claims latex → image blocks
  │
  │ Phase 2 — on renderers:
  │   tui-renderer:  text → markdown, code-block → highlight, image → terminal protocol
  │   (any renderer: web UI, logger, etc.)
```

The tui-renderer is just an extension. It uses the same `createFencedBlockTransform` primitive that any extension can use. No special privileges.

### Content Blocks

The pipeline carries **typed content blocks**:

```typescript
type ContentBlock =
  | { type: "text"; text: string }                          // markdown text
  | { type: "code-block"; language: string; code: string }  // fenced code block
  | { type: "image"; data: Buffer }                         // PNG → terminal image protocol
  | { type: "raw"; escape: string }                         // raw terminal escape
```

Events always carry `{ blocks: ContentBlock[] }`. Extensions never write to `process.stdout` directly.

### Composable Primitives

Three tools, each operating on a disjoint domain:

| Primitive | Operates on | Produces | Use case |
|---|---|---|---|
| `createBlockTransform` | text blocks (inline delimiters) | any block type | `$$...$$`, `<<...>>` |
| `createFencedBlockTransform` | text blocks (line fences) | any block type | ` ``` `, `:::`, `~~~` |
| `bus.onPipe` directly | any block type | any block type | claim code-blocks, filter, enrich |

Each primitive processes only its input type and passes everything else through.

## Project Structure

```
agent-sh/
├── src/
│   ├── index.ts            # Interactive terminal entry point (CLI args, Shell, extensions)
│   ├── core.ts             # createCore() — frontend-agnostic kernel, library entry point
│   ├── event-bus.ts        # Typed EventBus: emit/on, emitPipe, emitPipeAsync, emitTransform
│   ├── shell.ts            # PTY lifecycle + wiring (InputHandler + OutputParser)
│   ├── input-handler.ts    # Keyboard input, agent mode, bus-driven autocomplete
│   ├── output-parser.ts    # OSC parsing, command boundary detection
│   ├── context-manager.ts  # Exchange log, context assembly, recall API
│   ├── settings.ts         # User settings (~/.agent-sh/settings.json)
│   ├── extension-loader.ts # Extension loading (-e, settings.json, extensions dir)
│   ├── executor.ts         # Isolated child process execution (shared by shell + bash tool)
│   ├── types.ts            # Shared type definitions
│   │
│   ├── agent/              # Agent backends (behind AgentBackend interface)
│   │   ├── types.ts        # AgentBackend, ToolDefinition, ToolResult
│   │   ├── index.ts        # Factory: config → AgentLoop or AcpClient
│   │   ├── agent-loop.ts   # Internal agent (OpenAI-compat API, bus-driven)
│   │   ├── acp-client.ts   # ACP subprocess agent (bus-driven)
│   │   ├── mcp-server.ts   # Standalone MCP server for ACP bridge tools
│   │   ├── tool-registry.ts       # Map-based tool registry
│   │   ├── conversation-state.ts  # OpenAI chat messages array
│   │   ├── system-prompt.ts       # System prompt builder
│   │   └── tools/          # Built-in tool implementations
│   │       ├── bash.ts, read-file.ts, write-file.ts, edit-file.ts
│   │       ├── grep.ts, glob.ts, ls.ts, user-shell.ts
│   │
│   ├── utils/              # Shared primitives
│   │   ├── llm-client.ts   # OpenAI SDK wrapper (shared by agent loop + extensions)
│   │   ├── palette.ts, ansi.ts, diff.ts, diff-renderer.ts
│   │   ├── box-frame.ts, tool-display.ts, output-writer.ts
│   │   ├── stream-transform.ts, markdown.ts, file-watcher.ts
│   │   └── line-editor.ts, frame-renderer.ts
│   │
│   └── extensions/         # Built-in extensions
│       ├── tui-renderer.ts, slash-commands.ts
│       ├── file-autocomplete.ts, shell-recall.ts
│       ├── shell-exec.ts, command-suggest.ts
│
├── examples/               # Example extensions and agent integrations
├── docs/                   # Documentation
├── package.json
└── tsconfig.json
```
