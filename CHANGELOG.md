# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Releases before this file are recorded in the git tags and GitHub releases.

## [Unreleased]

## [0.15.11] - 2026-08-30

### Added

- DeepSeek: `deepseek-v4-flash-vision-exp`, a multimodal V4 variant that accepts
  images alongside text (1M context, reasoning with echoed thinking). The two
  existing V4 models are untouched and stay text-only.
- Z.AI Coding Plan: `glm-5.3` and `glm-5.3-flash`, both with a 1,048,576-token
  context window. `glm-5.3-flash` is natively multimodal and accepts images.

### Changed

- Z.AI Coding Plan's model list now matches the GLM Coding Plan documentation.
  `glm-5.1` and `glm-4.5-air` are gone, and `glm-5-turbo`'s context window is
  corrected from 200,000 to 204,800. The default model moves from `glm-5.1` to
  `glm-5.3`. A persisted `/model` selection pointing at a removed id will need
  reselecting.

### Fixed

- The OSC 7 cwd sequence no longer shells out to `hostname`, which isn't
  installed everywhere — on Arch it ships in the optional inetutils package, and
  without it every prompt printed
  `__agent_sh_precmd:1: command not found: hostname`. Each shell's own host
  variable is used instead: `$HOST` (zsh), `$HOSTNAME` (bash), `$hostname`
  (fish). That also drops one subprocess per prompt. The host portion of OSC 7
  is advisory — the output parser matches `file://[^/]*` and consumes only the
  path — so a shell that leaves the variable empty is still handled correctly.
- Z.AI Coding Plan: reasoning level `off` on `glm-5.3-flash` no longer sends
  `{ thinking: { type: "disabled" } }`, a shape that model rejects because its
  `thinking.type` accepts only `"enabled"`. On that model `off` now maps to an
  enabled block at low effort; every other GLM model still disables thinking
  outright.

## [0.15.10] - 2026-07-12

### Fixed

- Subagents no longer destabilize the parent agent's prompt cache. The
  subagent runner returned its entire multi-iteration transcript, which the
  parent appended as a single tool_result; on long runs this bloated the
  parent's context enough to trip auto-compaction, rewriting the cached
  prompt prefix and cold-starting the provider's prompt cache. Subagents now
  return only their final assistant message. Live tool events are unchanged,
  so intermediate steps still render.

## [0.15.9] - 2026-06-14

### Fixed

- Floating panel (overlay agent): tool output with CRLF line endings (e.g.
  ssh's stderr warnings) no longer renders as staircased, left-truncated
  lines inside the panel. The trailing `\r` survived into panel content
  rows and repainted each composited row from column 0; panel rows now
  strip cursor-moving control bytes (keeping colors), and the TUI's
  command-output splitter treats `\r\n` as a line break.
- Shell frontend: pasting multibyte text (e.g. Chinese) no longer corrupts
  characters into `�` when the paste spans multiple stdin chunks. The stdin
  reader decoded each chunk independently, tearing UTF-8 sequences at chunk
  boundaries; it now decodes statefully across chunks.
- Shell frontend: a pasted multi-line query starting with `/` (e.g. a file
  path) is now sent to the agent instead of being misparsed as a slash
  command. Only single-line queries dispatch as commands.
- Shell frontend: multi-line queries no longer corrupt the input history
  file. Entries are stored with newlines escaped, so a multi-line paste
  recalls as one history entry instead of splitting into several bogus ones.
- Shell frontend: multi-line bracketed pastes keep their line breaks on
  terminals that send pasted newlines as `\r` (xterm convention — iTerm2,
  Terminal.app). The paste accumulator deleted `\r` instead of normalizing
  it to `\n`, silently joining the paste into one line. Ghostty/kitty
  (verbatim `\n`) were unaffected.

## [0.15.8] - 2026-06-10

### Added

- OpenRouter requests now send an `x-session-id` header keyed on the frontend's
  resume-stable session id, pinning sticky provider routing so prompt caches stay
  warm across turns — including after compaction rewrites the opening messages,
  the case OpenRouter's default message-hash routing misses. Wired through a new
  per-provider `requestHeaders` endpoint hook (scoped to OpenRouter only) and a
  `session:current-id` handler the frontend supplies; absent that handler no
  header is sent.
- `latex-images` extension now renders inline `$…$` math as inline images under
  the ashi frontend on kitty/Ghostty terminals, flowing within wrapped markdown
  text (bold/italic and text selection preserved). Display `$$…$$` math is
  unchanged. Inline detection follows pandoc's `$…$` delimiter rules so prose,
  currency (`$5 and $10`), and inline code spans don't false-match. Inline
  rendering is gated on the terminal's kitty Unicode-placeholder support; other
  terminals leave inline `$…$` as text.
- ashi pi-tui renderer: markdown can host inline images via the kitty Unicode
  placeholder protocol. Producers register a PNG (`ashi:inline-image:register`)
  and embed the returned id as a sentinel; the renderer transmits the image
  out-of-band and flows it inline as width-correct placeholder cells.

### Fixed

- ashi user shell: the command label shown above each `!` command's output could
  be the *previous* command (e.g. an `ls` rendered as the preceding `cd`). ashi
  composes and sends the command itself, but the label was reconstructed from
  the shell's echoed text instead. It now displays the exact line ashi wrote to
  the pty (threaded through the pending-intent queue), which is also what's
  recorded for the agent's context. Shell markers are still used to capture
  output and detect command boundaries — only the command text no longer
  round-trips through the shell.
- Bash preexec hook (non-ashi shell frontend): the command text recovered for
  the agent's context derived from `history 1`, which goes stale when the user's
  `PROMPT_COMMAND` reloads history (`history -c`/`-r` for cross-session sharing).
  It now falls back to `$BASH_COMMAND` whenever the history entry doesn't match
  the command bash is about to run, keeping the full typed line (pipelines,
  history-recalled commands) in the common case. zsh and fish were unaffected
  (they read the exact command from preexec `$1`/`$argv`).

## [0.15.7] - 2026-06-07

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

- Bash/tool output no longer corrupts multibyte UTF-8 (e.g. CJK text, emoji).
  The executor decoded each stdout/stderr chunk independently with
  `Buffer.toString("utf-8")`, so any character whose bytes straddled a chunk
  boundary became replacement characters (`�`). Each stream now decodes through a
  `StringDecoder` that holds an incomplete trailing sequence until the next
  chunk. This corrupted the agent-visible tool result too, not just the display.

- ashi: a single pathologically wide line in bash/tool output (minified HTML,
  one-line JSON) no longer wraps across the whole viewport. The preview clamped
  the number of lines but not their width, so one 2000-column line counted as a
  single line yet soft-wrapped over dozens of rows. Each previewed line is now
  truncated to the body width with an `…`; expanding still shows full lines and
  the agent always receives the untruncated output.

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

- Rolling-history prefetch now runs after the agent backend activates, fixing a
  race where prior-session context was silently dropped on new sessions.
- `conversation_recall` tool description now accurately describes the store as a
  persistent cross-session memory rather than "evicted conversation turns".
- The `command-suggest` tool is no longer presented to the model when no shell
  frontend is attached, so the agent won't suggest shell commands that can't be
  staged at the prompt.

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
