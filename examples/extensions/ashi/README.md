# ashi

[![npm version](https://img.shields.io/npm/v/@guanyilun/ashi.svg)](https://www.npmjs.com/package/@guanyilun/ashi)
[![license](https://img.shields.io/npm/l/@guanyilun/ashi.svg)](https://github.com/guanyilun/agent-sh/blob/main/LICENSE)

`ash` (the built-in agent of [agent-sh](https://github.com/guanyilun/agent-sh)) running as a standalone interactive TUI — no shell underneath, just the agent.

Same backend, tools, slash commands, providers, and skills as `agent-sh`, mounted in a chat-style interface with session history, branching, and LLM-driven compaction.

## Install

```bash
npm install -g @guanyilun/ashi
ashi
```

Reads `~/.agent-sh/settings.json` for provider profiles and defaults, same file as `agent-sh`. The quickest path is exporting `OPENROUTER_API_KEY` or `OPENAI_API_KEY` and running `ashi`.

To scaffold the config directory from scratch:

```bash
ashi init          # creates ~/.agent-sh/settings.json and AGENTS.md
ashi auth login    # store an API key interactively
```

## Usage

```bash
ashi                                   # launch with defaults
ashi --provider openrouter             # pick a provider profile
ashi --model anthropic/claude-sonnet-4 # override model
ashi -e claude-code-bridge --backend claude-code  # swap the agent backend
```

### CLI flags

```
--provider <name>    Provider profile from ~/.agent-sh/settings.json
--model <id>         Override model
--api-key <key>      Direct API key
--base-url <url>     OpenAI-compatible base URL
--backend <name>     Agent backend (default: ash). Requires the matching
                     backend extension to be loaded, e.g. via -e.
-e, --extensions     Extra extensions to load (comma-separated)
```

The built-in backend is `ash`. To use a different one (claude-code, opencode, pi), load the corresponding bridge extension with `-e` and pass `--backend <name>`.

### Management subcommands

```
ashi install <name> [--force]   Install an extension into ~/.agent-sh/extensions/
ashi uninstall <name>           Remove an installed extension
ashi list                       List installed extensions
ashi auth login [provider]      Store an API key (interactive)
ashi auth logout <provider>     Remove a stored key
ashi auth list                  Show configured providers
ashi init [--force]             Scaffold ~/.agent-sh/ (settings, AGENTS.md)
```

These mirror `agent-sh`'s management commands so `ashi` works as a standalone CLI without needing the full `agent-sh` install.

### Keybindings

```
Esc          Cancel active turn
Ctrl+C       Clear editor
Ctrl+D       Quit (when editor is empty)
Ctrl+T       Toggle thinking-block visibility (hidden by default)
Shift+Tab    Cycle thinking level (off → low → medium → high → …)
Ctrl+O       Expand/collapse all tool calls and results in chat
```

The current thinking level is shown in the footer as `[level]` next to the model name.

## Sessions

Many sessions per cwd, fresh by default:

```
/resume       Browse past sessions in this cwd (interactive picker)
/new          Start a fresh session (discards in-memory context)
/name <text>  Set a display name for the current session
/sessions     Text dump of all sessions in this cwd
```

Each session is its own tree (one JSONL file per session). Every entry has an `id` and `parentId`; sibling branches stay on disk; you can rewind and branch within a session.

```
/fork              Interactive in-session tree picker
/fork <id-prefix>  Direct rewind to a specific entry
/branch            Text dump of the active branch (root → leaf)
```

Storage: `~/.agent-sh/extensions/ashi/history/<cwd-slug>/sessions/<id>.jsonl`. Each line is a `SessionEntry`:

```typescript
type SessionEntry =
  | { type: "session"; id; parentId: null; cwd; timestamp; version }
  | { type: "message"; id; parentId; timestamp; message: AgentMessage }
  | { type: "compaction"; id; parentId; timestamp; summary; firstKeptId; tokensBefore };
```

Raw `AgentMessage` objects are stored verbatim (full tool call arguments, tool results, etc.) so `/resume` and `/fork` faithfully reconstruct the original conversation.

## Compaction

LLM-driven structured compaction, triggered automatically when prompt tokens cross the threshold or manually with `/compact`:

1. Walk back from the newest message until ~20K tokens are kept; never cut at tool results or mid–assistant-tool-call group.
2. LLM summarizes the older span into a structured format (Goal / Constraints / Progress / Decisions / Next Steps / Critical Context).
3. The live message array becomes `[summary, ...kept messages]`.
4. The summary is persisted as a `CompactionEntry` carrying `summary`, `firstKeptId`, and `tokensBefore`. Subsequent compactions reference the previous one's summary so chains stay coherent.

If the LLM call fails or the conversation is too short, falls through to the default eviction.

## Display configuration

Per-tool compactness lives under `ashi.display` in `~/.agent-sh/settings.json`:

```json
{
  "ashi": {
    "display": {
      "default": { "result": "preview", "previewLines": 8 },
      "read":    { "result": "hidden" },
      "ls":      { "result": "hidden" },
      "grep":    { "result": "summary" },
      "bash":    { "result": "preview", "previewLines": 12 },
      "edit":    { "result": "preview" },
      "write":   { "result": "preview" }
    }
  }
}
```

`result` modes:

- `"hidden"` — call line only while streaming; line count (`↳ 42 lines`) after completion.
- `"summary"` — 2-line tail while streaming; line count after completion.
- `"preview"` — last `previewLines` lines of output (default 8), with a `... (N more lines)` hint when content overflows.

For `edit_file` / `write_file`, the diff frame is treated as the output and follows the same gating: shown for `preview`, hidden for `hidden`/`summary` (the call line already carries `+12 -3` stats). The line-count hint is suppressed for diff-producing tools so edits stay quiet.

Hit `Ctrl+O` to toggle expansion across all tool entries in chat — result bodies show their full output regardless of mode, and call lines with truncated labels (e.g. long `bash` commands) reveal their full text. Press again to collapse.

Each tool inherits from `default` and is overridden by its own block. Unknown tool names fall through to `default`.

## Extension surface

Other extensions can override how chat entries and tool results render without forking ashi. Hooks are exposed via `ctx.define` (defaults) + `ctx.advise` (override).

Components returned from these hooks are widgets from [`@earendil-works/pi-tui`](https://www.npmjs.com/package/@earendil-works/pi-tui) — the TUI framework ashi is built on.

### Chat hooks

| Hook | Args | Returns |
|---|---|---|
| `ashi:render-user-message` | `{ text, state, invalidate }` | `Component` |
| `ashi:render-assistant` | `{ text, state, invalidate }` | `Component` |
| `ashi:render-thinking` | `{ text, hidden, state, invalidate }` | `Component` |

### Tool hooks (per-tool)

Tool rendering is split into a call line (the input header) and a result body (streaming output + final state). Each side is dispatched by tool name with a `:default` fallback:

| Hook | Args | Returns |
|---|---|---|
| `ashi:render-tool-call:{name}` | `{ toolCallId, name, title, kind, displayDetail, rawInput, state, invalidate }` | `ToolCallView` |
| `ashi:render-tool-call:default` | (same) | `ToolCallView` |
| `ashi:render-tool-result:{name}` | `{ toolCallId, name, kind, rawInput, mode, previewLines, state, invalidate }` | `ToolResultView` |
| `ashi:render-tool-result:default` | (same) | `ToolResultView` |

`state` is a per-call mutable bag; `invalidate()` requests a re-render.

- `ToolCallView` extends `Component` with `setStatus({ exitCode, elapsedMs, summary })` — called once on completion. Optional `toggleExpanded()` lets long labels reveal their full text on Ctrl+O.
- `ToolResultView` extends `Component` with `appendChunk(chunk)`, `setDiff(lines)`, `finalize({ exitCode, summary })`, and `toggleExpanded()` — ashi mutates the result view as output streams in and toggles it on Ctrl+O.

`mode` and `previewLines` on result args come from `ashi.display.{name}` config so renderers can honor the user's compactness preference without re-implementing the resolution logic.

Example: override how `bash` calls render.

```ts
export default function activate(ctx) {
  ctx.advise("ashi:render-tool-call:bash", (next, args) => {
    return new MyFancyBashLine(args);  // must implement ToolCallView
  });
}
```

For non-render concerns (commands, settings, tools, providers) use the standard `agent-sh` extension API. See the [agent-sh extension docs](https://github.com/guanyilun/agent-sh/blob/main/docs/extensions.md).

## Install from source

Alternative to the npm install, useful for hacking on ashi itself:

```bash
agent-sh install ashi          # copies examples/extensions/ashi → ~/.agent-sh/extensions/ashi
export PATH="$HOME/.agent-sh/bin:$PATH"
```

`agent-sh install` runs `npm install` and `npm run build` in the copied directory and symlinks the built bin into `~/.agent-sh/bin/`.

## Development

`@guanyilun/ashi` depends on the published `agent-sh` package. To iterate against a local checkout, use `npm link`:

```bash
# one-time: register the local agent-sh checkout
cd /path/to/agent-sh
npm run build
npm link

# in ashi, point its agent-sh dependency at the linked checkout
cd examples/extensions/ashi
npm install
npm link agent-sh

npm run dev      # tsx-driven, no compile step
# or: npm run build && node dist/cli.js
```

Rebuild agent-sh (`npm run build` at the repo root) whenever you change the kernel — the link picks up `dist/` directly. To go back to the published version, run `npm unlink agent-sh && npm install` inside `examples/extensions/ashi`.

## License

MIT
