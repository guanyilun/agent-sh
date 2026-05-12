# ashi

`ash` (agent-sh's built-in agent) running inside pi's TUI substrate, with no shell underneath.

A test of agent-sh's claim that the kernel is a frontend-agnostic communication layer: `ashi`
uses `createCore()` from agent-sh, skips `activateShell()`, disables the shell-coupled built-ins
(`shell-context`, `tui-renderer`, `file-autocomplete`), and mounts `@earendil-works/pi-tui` as
the only frontend. Backend, tools, slash commands, providers, and skills come along unchanged.

## Setup

```bash
cd examples/extensions/ashi
npm install
npm run build   # or `npm run dev` for a tsx-driven run without compiling
```

`file:../../..` wires `agent-sh` to the parent checkout; run `npm run build` at the repo root
first if you haven't already.

## Install

```bash
agent-sh install ashi
export PATH="$HOME/.agent-sh/bin:$PATH"
ashi
```

`agent-sh install` copies this directory into `~/.agent-sh/extensions/ashi/` (preserving
`node_modules/`, so the local `agent-sh` symlink resolves), then symlinks the built bin into
`~/.agent-sh/bin/`.

## Configure

Reads `~/.agent-sh/settings.json` for providers and defaults, same as `agent-sh` itself. The
quickest path is exporting `OPENROUTER_API_KEY` or `OPENAI_API_KEY` and running `ashi`.

CLI flags mirror `agent-sh`:

```
--provider <name>    Provider profile from ~/.agent-sh/settings.json
--model <id>         Override model
--api-key <key>      Direct API key
--base-url <url>     OpenAI-compatible base URL
--backend <name>     Agent backend (default: ash)
-e, --extensions     Extra extensions to load (comma-separated)
```

## Keybindings

Match pi-coding-agent's convention:

```
Esc      Cancel active turn
Ctrl+C   Clear editor
Ctrl+D   Quit (when editor is empty)
```

## History tree

ashi swaps the linear `~/.agent-sh/history` JSONL for a pi-style tree, persisted per-cwd
under `~/.agent-sh/extensions/ashi/history/<cwd-slug>/tree.jsonl`. Each entry carries a
`parentSeq`; sibling branches live on disk so you can navigate between them.

```
/tree      Show the whole tree, marking the active branch and fork points
/branch    Show the active branch (root → leaf)
/fork <seq> Reparent the next turn off <seq> instead of the current leaf
```

`/fork` only changes the on-disk parent pointer for the *next* batch — it doesn't rewind the
agent's in-context messages. Full conversation replay from a branch is a follow-up.

The kernel side of this is just three lines: an optional `parentSeq` on `NuclearEntry` plus
optional `getBranch` / `getTree` / `setLeaf` on `HistoryAdapter`. Everything else (storage,
walk, slash commands) lives in this extension.

## Compaction

ashi replaces agent-sh's default deterministic two-tier-pin compaction with a pi-style
LLM-driven path:

1. Cut point: walk back from the newest message until ~20K tokens are kept; never cut at
   tool results or in the middle of an assistant→tool call group.
2. LLM summarizes the older span into the pi structured format (Goal / Constraints /
   Progress / Decisions / Next Steps / Critical Context).
3. The live message array becomes `[summary, ...kept messages]`.
4. The summary lands in the tree as a `compaction` `NuclearEntry`, parented at the
   pre-compaction leaf. Subsequent compactions reference the previous one's summary so
   chains stay coherent.

Triggered automatically when prompt tokens cross agent-sh's threshold, or manually with
`/compact`. If the LLM call fails or the conversation is too short, falls through to the
default eviction.

The kernel exposes one extra handler (`conversation:allocate-seq`) so the compaction entry
gets a fresh seq from the same counter as kernel-produced entries. Everything else
(prompt template, cut-point walker, serialization, LLM call) lives in this extension.

## What's intentionally missing

This is a spike, not a clone of pi's full UI. The MVP renders:

- User submissions, streaming assistant Markdown
- Tool invocations with start/complete state
- Slash commands with autocomplete (`/help`, `/model`, `/backend`, `/tree`, `/fork`, …)
- Tree-shaped on-disk history with `/fork` divergence
- Loader, errors, info messages

Out of scope for v0: permission dialogs, diff renderer, file-path autocomplete, session
selector, theme selector, image rendering, full conversation rewind on fork. Each can be
added by writing a pi-tui Component and subscribing to the corresponding bus event.
