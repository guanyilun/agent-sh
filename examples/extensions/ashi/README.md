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

ashi mirrors pi's session model: many sessions per cwd, fresh by default.

```
/resume      Browse past sessions in this cwd (interactive picker)
/new         Start a fresh session (discards in-memory context)
/name <text> Set a display name for the current session
/sessions    Text dump of all sessions in this cwd
```

Each session is its own tree (one JSONL file per session). Every entry has an `id` and
`parentId`; sibling branches stay on disk; you can rewind and branch within a session.

```
/fork              Interactive in-session tree picker
/fork <id-prefix>  Direct rewind to a specific entry
/branch            Text dump of the active branch (root → leaf)
```

Storage: `~/.agent-sh/extensions/ashi/history/<cwd-slug>/sessions/<id>.jsonl`. Each line
is a `SessionEntry`:

```typescript
type SessionEntry =
  | { type: "session"; id; parentId: null; cwd; timestamp; version }
  | { type: "message"; id; parentId; timestamp; message: AgentMessage }
  | { type: "compaction"; id; parentId; timestamp; summary; firstKeptId; tokensBefore };
```

Raw `AgentMessage` objects are stored verbatim (full tool call arguments, tool results,
etc.) so `/resume` and `/fork` faithfully reconstruct the original conversation — same
shape as pi's session format.

The kernel side adds three small handlers:
optional `parentSeq`/`getBranch`/`getTree`/`setLeaf` on `NuclearEntry`/`HistoryAdapter`
(useful for tree-aware HistoryAdapters in general — not used by this extension);
`conversation:allocate-seq` and `conversation:reset-for-session` so multi-session adapters
can swap context without nuclear-state bleed-through.

ashi itself bypasses agent-sh's `NuclearEntry` pipeline entirely by installing a
`NoopHistory` adapter — raw messages are captured directly via `agent:processing-done`
and the `conversation:get-messages` handler.

## Compaction

ashi replaces agent-sh's default deterministic two-tier-pin compaction with a pi-style
LLM-driven path:

1. Cut point: walk back from the newest message until ~20K tokens are kept; never cut at
   tool results or in the middle of an assistant→tool call group.
2. LLM summarizes the older span into the pi structured format (Goal / Constraints /
   Progress / Decisions / Next Steps / Critical Context).
3. The live message array becomes `[summary, ...kept messages]`.
4. The summary lands in the session as a `CompactionEntry` carrying `summary`,
   `firstKeptId`, and `tokensBefore` — same shape as pi's compaction. Subsequent
   compactions reference the previous one's summary so chains stay coherent.

Triggered automatically when prompt tokens cross agent-sh's threshold, or manually with
`/compact`. If the LLM call fails or the conversation is too short, falls through to the
default eviction.

The cut-point walker, prompt template, serialization, and LLM call all live in this
extension. The kernel side is just the advisable `conversation:compact` seam.

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

## Extension surface

Other extensions can override how chat entries render without forking ashi.
Four hooks are exposed via `ctx.define` (defaults) + `ctx.advise` (override):

| Hook | Args | Returns |
|---|---|---|
| `ashi:render-user-message` | `{ text, state, invalidate }` | `Component` |
| `ashi:render-assistant` | `{ text, state, invalidate }` | `Component` |
| `ashi:render-thinking` | `{ text, hidden, state, invalidate }` | `Component` |
| `ashi:render-tool-execution` | `{ toolCallId, name, title, kind, displayDetail, rawInput, state, invalidate }` | `ToolExecutionView` |

`state` is a per-call mutable bag; `invalidate()` requests a re-render.

`ToolExecutionView` extends `Component` with `appendOutput(chunk)`, `setBody(lines)`,
`complete(exitCode, summary)` — ashi mutates the returned view as the tool progresses,
so custom renderers must satisfy this contract (or replace the entire tool render
including completion handling).

Example: override how `edit_file` results render.

```ts
export default function activate(ctx) {
  ctx.advise("ashi:render-tool-execution", (next, args) => {
    if (args.kind !== "write") return next(args);
    return new MyPrettyEditView(args);  // must implement ToolExecutionView
  });
}
```

For non-render concerns (commands, settings, tools, providers) use the standard
agent-sh extension API.

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
