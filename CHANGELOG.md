# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Releases before this file are recorded in the git tags and GitHub releases.

## [Unreleased]

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
