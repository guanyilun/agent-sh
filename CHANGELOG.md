# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Releases before this file are recorded in the git tags and GitHub releases.

## [Unreleased]

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
