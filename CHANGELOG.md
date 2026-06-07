# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Releases before this file are recorded in the git tags and GitHub releases.

## [Unreleased]

### Added

- `LICENSE` file (MIT) — matches the license declared in `package.json` and the
  README badge, which previously linked to a missing file.
- `AGENT_SH_DEFAULT_CONTEXT_WINDOW` environment variable overrides the 60k
  fallback context window used when neither the model nor settings declares one
  (a positive integer; ignored otherwise).

### Changed

- Event bus now isolates listener faults. A throwing subscriber or transform no
  longer propagates out of `emit` (which could abort an in-flight turn) or stop
  sibling listeners — each callback site (fire-and-forget listeners, the `onAny`
  tap, and the sync/async transform pipes) is wrapped individually. Faults route
  through a host-installable reporter; the kernel surfaces them on the universal
  `ui:error` channel (and to stderr under `DEBUG`) instead of throwing or
  silently swallowing.

- Shell-mode markdown now uses a truecolor theme matching the ashi frontend
  (gold headings, teal inline code and list bullets, blue underlined links, gray
  blockquote bars and horizontal rules) instead of the terminal's 16-color
  palette, so it reads consistently across terminal profiles. Adds dedicated
  `md*` slots to the color palette.
- Floating panel (overlay extensions): Up/Down arrows and the scroll wheel now
  scroll the transcript in the input/idle phase, matching their behavior while
  the agent is working. Previously they navigated input history, so after a
  reply there was no way to scroll back through it (the panel owns its alt
  screen, where terminals route the wheel through arrow keys). Input history
  moved to Ctrl+P / Ctrl+N; PageUp/PageDown still page-scroll.
- `conversation_recall` search now treats the query as a real regex (e.g.
  `foo|bar`), falling back to literal matching only when the pattern is invalid;
  it was previously always escaped to a literal. `browse` and `search` also
  accept `offset`/`limit`, so results past the first page are now reachable.
- Auto-compaction now reports on success (`(auto-compacted: ~X → ~Y tokens,
  evicted N)`) and stays silent on a no-op, inverting the previous behavior
  where only the "nothing to evict" failure was surfaced — so a compaction that
  silently shrinks context is now visible.

### Fixed

- ashi: the footer's compaction counter (`⊟ N`) now resets when you start a new
  session, resume, or fork a branch. The count is a frontend-local tally
  incremented on each `conversation:after-compact`; `rebuildChat()` — the reload
  path for every session/branch switch — cleared the other per-conversation view
  state but left this one, so a fresh session kept showing the previous session's
  count.

- ashi: a successful compaction no longer desyncs the capture index→id map and
  aborts the next auto-compaction with "kept-message has no on-disk entry". The
  kept messages and their on-disk entry ids are now taken from a single
  `buildBranchWithIds()` rebuild, instead of replacing the conversation from
  `buildMessages()` and re-deriving the ids by index — the two could drift,
  leaving a kept slot with a null id that failed the next compaction's lookup.

- ashi: an assistant message whose text ends with a blank line no longer renders
  a stray empty row before the following tool call. Some models emit trailing
  newlines after their reply text, and the markdown renderer turned a trailing
  blank line into a visible row — doubling the gap before tool calls. Trailing
  whitespace is now stripped from the assistant buffer for display; blank lines
  between sections are preserved.

- Shell-mode tool output no longer interleaves when a batch runs read-only
  tools in parallel. Their start/complete events arrive interleaved (e.g. two
  reads and a search all start, then complete in any order), and the renderer
  streamed each line as its event arrived — so results landed under the wrong
  header, a dimmed `read (cont.)` block relisted files, and a search result
  could appear under a `read` header. Read-only tools in a multi-tool batch are
  now buffered and rendered as one contiguous block per group, in dispatch
  order, the moment the group's members return — each file carrying its own
  inline `✓`/`✗` result. Single-tool turns and sequential mutating/streaming
  tools (bash, edit) still render live.

- The `openai-compatible` provider now reads each model's context window from the
  `/v1/models` catalog — llama.cpp's `meta.n_ctx` and vLLM's `max_model_len` —
  instead of keeping only the id. Local llama.cpp/vLLM models previously fell back
  to the 60k default, which also drove auto-compaction to trigger far earlier than
  the server's real window. Servers that expose neither field are unaffected.

### Documentation

- Audited the README and `docs/` against the source and corrected stale content:
  the built-in provider list, the ash system-prompt structure, the tool-output
  truncation threshold, a deleted shared utility, three nonexistent agent-loop
  handlers, the `modeInstruction` input-mode field, the `RenderSurface`
  interface, and the shell redraw lifecycle hook.
- Expanded the model-configuration guide to document every per-model capability
  (`contextWindow`, `maxTokens`, `modalities`, `reasoning`, `echoReasoning`) and
  the provider-level fields; refreshed all example model names to current
  open-weight models (deepseek-v4-flash, gemma4, mimo).

## [0.15.6] - 2026-06-04

### Added

- `agent-sh/skills` entry point exposing `discoverGlobalSkills()` and
  `invalidateGlobalSkillsCache()`, so downstream tools can discover and
  invalidate installed skills without reimplementing the filesystem scan.
- `command-suggest` example extension: stages an agent-suggested shell command
  at the user's prompt after the response finishes, ready to edit or run with
  Enter instead of being copy-pasted.

### Changed

- `ToolDisplayInfo.kind` is now optional. A tool that sets a self-describing
  `icon` can omit it, and the TUI then renders icon + detail with no verb —
  previously every tool was forced to show one of read/write/execute/search.

### Removed

- Stale `agent-sh/agent/history-file` subpath export. Its source was deleted, so
  a clean build never produced the target and the export resolved to a missing
  module in published tarballs.

### Fixed

- Rolling-history prefetch now runs after the agent backend activates, fixing a
  race where prior-session context was silently dropped on new sessions.
- `conversation_recall` tool description now accurately describes the store as a
  persistent cross-session memory rather than "evicted conversation turns".

- Diff rendering (edit/write previews) now wraps long lines across rows instead
  of truncating them with an ellipsis, so the full changed line is always
  visible. `wrapLine` also hard-breaks an over-long token (long identifier, URL)
  that first appears mid-line, which previously overflowed the wrap width.
- Inline word-level emphasis in diffs now applies to long (paragraph-length)
  lines too. The token-LCS that highlights changed words was skipped past a
  ~220-token-per-side cost guard, leaving the whole line a flat tint; it now
  anchors the shared prefix/suffix and diffs only the changed middle, so long
  edits still show what actually changed.
- Diff line numbers in shell-mode previews are now colored by line type (red
  for removed, green for added, dim for context) instead of a uniform dim. A
  single gutter mixes old-file numbers (deletions) with new-file numbers
  (additions/context), so the uncolored column read as a confusing
  non-monotonic sequence; the color now signals which file each number refers
  to, matching how the ashi frontend already renders them.

## [0.15.5] - 2026-06-04

### Changed

- Shell environment capture is cached on disk, keyed on the shell and the
  mtimes of its rc files. Launch previously sourced the user's interactive
  config twice — once to snapshot env vars, again in the interactive shell —
  paying the full rc cost (oh-my-zsh, nvm, conda, …) on each. Repeat launches
  now reuse the snapshot and skip the redundant sourcing (~1s+ on heavy
  configs); editing an rc file invalidates the cache. Set
  `AGENT_SH_SHELL_ENV_NOCACHE=1` to force a fresh capture.

## [0.15.4] - 2026-06-03

### Added

- `diffText` palette slot — the foreground color for diff row text, overridable
  via `setPalette()`.

### Changed

- Diff rows render the `+`/`-` sigil in color but the line text in a readable
  foreground (the new `diffText` slot), fixing the low-contrast red-on-maroon /
  green-on-green text.
- Diffs group git-style — the whole removed run, then the whole added run —
  instead of interleaving removed and added lines one by one.
- Changed tokens are no longer bold; the row tints and changed-token emphasis
  backgrounds are softened.
- The `openai-compatible` provider now emits the `reasoning_effort` shape
  (`"none"` when thinking is off), so `thinkingLevel: "off"` actually disables
  reasoning on local servers that honor it instead of sending no parameter.
  Override with `reasoningShape` or a user extension for servers wanting a
  different disable token.

## [0.15.3] - 2026-06-03

### Fixed

- The settings provider overlay is now rebuilt on every `agent:providers:changed`
  event, so a host `reloadSettings()` picks up `apiKey` / `baseURL` edits (and
  added or removed providers) without a process restart. Previously it was read
  once at load and went stale, so a changed key took effect only after a restart.
- `agent:tool-output-chunk` now carries `toolCallId`, so streamed tool output
  routes to the producing tool's display. Read-only tools run as a parallel
  batch, so with positional routing each tool's streamed output landed in the
  most-recently-started tool's body — concurrent calls cross-rendered. Frontends
  that ignore the field still work (they fall back to most-recent).

## [0.15.2] - 2026-06-02

### Added

- `agent:tools:visible` — a filter point on the assembled tool list as the model
  sees it, applied after `getTools()`, so a frontend or extension can restrict
  the model's tools without affecting tool lookup, execution, or tool bridges
  (which need the full list). Inert by default.
- `system-prompt:identity` — a handler for the system prompt's identity section
  (defaulting to the kernel identity), so a frontend or app can replace the
  identity without overriding the whole `system-prompt:build`. Inert by default.

## [0.15.1] - 2026-06-01

### Fixed

- The published package now ships `docs/` and `src/`, so the system prompt's
  `STATIC_GUIDE` pointers (agent-sh docs + source) resolve in npm installs
  instead of dead-ending and sending the agent hunting.

## [0.15.0] - 2026-06-01

### Changed

- **Breaking — model-selection surface renamed.** `AgentMode` is now `Model`: a
  serializable identity + capabilities, with `provider` required and the `model`
  field renamed to `id`. The credentials (`apiKey`/`baseURL`) and the
  reasoning/cache closures moved out of the model into a new internal
  `ModelEndpoint`, resolved by `(provider, id)` via `agent:resolve-endpoint`.
  - Handlers: `agent:get-modes` → `agent:get-models`, `agent:get-mode` → `agent:get-model`.
  - Events: `agent:modes-changed` → `agent:models-changed`; `config:switch-model`
    payload `{ model }` → `{ id, provider }`; `config:get-models` entries are now
    full `Model[]` (`.model` → `.id`, plus capability fields).
  - Silent-breaking at runtime for unmigrated extensions (string-keyed handlers /
    loose bus payloads); no end-user behavior change. Warrants a minor bump.
    Migration guide: [#234](https://github.com/guanyilun/agent-sh/pull/234).
