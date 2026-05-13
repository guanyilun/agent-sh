# ashi

`ash` (agent-sh's built-in agent) running inside pi's TUI substrate, with no shell underneath.

A test of agent-sh's claim that the kernel is a frontend-agnostic communication layer: `ashi`
uses `createCore()` from agent-sh, skips `activateShell()`, disables the shell-coupled built-ins
(`shell-context`, `tui-renderer`, `file-autocomplete`), and mounts `@earendil-works/pi-tui` as
the only frontend. Backend, tools, slash commands, providers, and skills come along unchanged.

## Install

```bash
agent-sh install ashi
export PATH="$HOME/.agent-sh/bin:$PATH"
ashi
```

`agent-sh install` copies this directory into `~/.agent-sh/extensions/ashi/`, runs
`npm install` and `npm run build` there, and symlinks the built bin into `~/.agent-sh/bin/`.

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

## Sessions

ashi defaults to pi's many-sessions-per-cwd model: every launch starts a fresh session.
Past sessions live under `~/.agent-sh/extensions/ashi/history/<cwd-slug>/sessions/<id>/`
and you opt into resuming them with `/resume`.

```
/resume      Browse past sessions in this cwd (interactive picker)
/new         Start a fresh session (discards in-memory context)
/name <text> Set a display name for the current session
/sessions    Text dump of all sessions in this cwd
```

Each session is itself a tree: every entry carries a `parentSeq`, sibling branches stay
on disk, and you can rewind/branch within a session.

```
/fork        Open the in-session tree picker (interactive)
/fork <seq>  Direct rewind to <seq>
/branch      Text dump of the active branch (root → leaf)
```

Snapshots of the live message array are saved per leaf inside each session's directory,
so resuming a session puts the agent back into the exact context it had at shutdown
(including any compaction summaries). `/fork` to a snapshotted leaf rewinds the agent
context; `/fork` to a leaf that predates snapshotting just moves the on-disk parent
pointer.

The kernel side adds five small handlers:
`parentSeq` on `NuclearEntry`; optional `getBranch`/`getTree`/`setLeaf` on `HistoryAdapter`;
`conversation:allocate-seq` for synthesized entries; `conversation:reset-for-session` so
multi-session adapters can swap sessions without nuclear-state bleed-through.

### Alternative: single-tree-per-cwd

`LeafTrackingTreeAdapter` (in `src/leaf-tracking-tree-history.ts`) is the original adapter
ashi shipped with: one ever-growing tree per cwd, auto-resume the leaf at startup, no
session boundaries. Still exported; swap it into `cli.ts` instead of `MultiSessionTreeAdapter`
if you prefer that workflow.

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
- Slash commands with autocomplete (`/help`, `/model`, `/backend`, `/resume`, `/new`, `/fork`, …)
- Multi-session tree history with `/resume` and `/fork` pickers
- LLM compaction with summaries that survive across `/resume`
- Loader, errors, info messages

Out of scope for v0: branch summaries on `/fork` navigation (pi has this), `/clone`
(duplicate active branch into a new session), permission dialogs, diff renderer, file-path
autocomplete, session search/rename/delete inside the `/resume` picker, theme selector,
image rendering. Each can be added by writing a pi-tui Component and subscribing to the
corresponding bus event.

## Development

To iterate on ashi from inside this repo:

```bash
cd examples/extensions/ashi
npm install
npm run dev      # tsx-driven, no compile step
# or: npm run build && node dist/cli.js
```

`file:../../..` in `package.json` wires `agent-sh` to the parent checkout — run
`npm run build` at the repo root first if you haven't already.
