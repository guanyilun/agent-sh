# ashi-ink

An [Ink](https://github.com/vadimdemedes/ink) (React) renderer for [ashi](../ashi),
shipped as an extension. It registers `ashi:renderer:ink`; selecting it swaps ashi's
entire TUI from pi-tui to Ink without changing ashi itself — the demonstration that
ashi's renderer is a swappable extension point.

> Requires `@guanyilun/ashi` ≥ 0.2.0 — the `./renderer` contract and the
> `./render` symbols this builds against landed in 0.2.0.

## Use

From source, inside the agent-sh repo — the npm workspace links the local
`@guanyilun/ashi`, so no published release is needed. Run ashi via its dev
runner so `-e ashi-ink` resolves through the workspace:

```bash
npm install                                # once, at the repo root
npm run build -w @guanyilun/ashi -w ashi-ink
cd examples/extensions/ashi
ASHI_RENDERER=ink npm run dev -- -e ashi-ink
```

`-e ashi-ink` *loads* the extension (registering `ashi:renderer:ink`) and
`ASHI_RENDERER=ink` *selects* it. Loading and selecting are separate steps.

Persistent setup (no per-command flags), once `@guanyilun/ashi` ≥ 0.2.0 is
published — `ashi install` resolves it from npm:

```bash
ashi install ashi-ink            # auto-loads on every launch
# then in ~/.agent-sh/settings.json: { "ashi": { "renderer": "ink" } }
```

Selection precedence: `--renderer ink` > `ASHI_RENDERER=ink` > `ashi.renderer` in
settings > `pi-tui` (default).

## Its look

Ink follows Claude Code's chat design (a different look from pi-tui's):

- each sent user turn on a **faint gray band with a light-gray `❯` marker at
  column 0** (stock Ink's `<Box>` can't fill a rect, but a padded
  `<Text backgroundColor>` does, once `marked-terminal`'s `\x1b[0m` resets are
  stripped so they can't punch a hole in the background),
- each assistant turn under a **`⏺` bullet at column 0**, content hanging-indented
  to column 2; markdown is flush-left (`tab: 0`),
- **tools** as `⏺ Name(detail)` — the `⏺` **dimmed and blinking while running**,
  then solid **green** (ok) / **red** (error) — with output under a `⎿` gutter;
  **read/search groups** show `⏺ Reading N files… (ctrl+o to expand)` with the
  in-flight path(s) under `⎿` while active, settle to `⏺ Read N files` when done,
  and expand (Ctrl+O) to the full `⎿` list with per-file summaries,
- one blank line between top-level blocks (a tool result stays tight under its
  call) — the renderer owns the inter-block rhythm, like Claude Code's `marginTop`,
- tables grow to their content and only wrap once they'd exceed the terminal.

The entire tool look lives in the renderer (`paintCall` / `paintResult` /
`makeToolGroup`) consuming the substrate's schema data — the substrate decides
*what* a tool call is; Ink decides *how* it looks. pi-tui draws the same data as a
`├`/`└` tree; that they diverge is the proof the renderer fully owns presentation.

## How it works

ashi's substrate produces ANSI-styled content and drives renderers imperatively
(nodes mutate; `app.requestRender()` repaints). Ink is declarative. The bridge is a
retained-mode **vnode tree**: the renderer's node factories create mutable vnodes, a
React root walks them into `<Text>`/`<Box>`, and `requestRender()` bumps a version
store (`useSyncExternalStore`) that forces a re-render. Ink renders embedded ANSI
faithfully, so ashi's content needs no restyling — tool calls, diffs, markdown and
chat all come through. Tool rendering reuses the public ANSI projection from
[`@guanyilun/ashi/render`](../ashi/src/schema.ts) (`renderBody` / `segmentsToString`
/ …), exactly as the pi-tui renderer does.

**Scrollback uses `<Static>`.** Ink owns and repaints its whole managed region
every frame — so putting the entire transcript there means a tall conversation
gets `clearTerminal`'d and rewritten on every streamed chunk: you can't scroll, it
snaps to the bottom, and the spinner starves. Instead, settled turns render through
Ink's [`<Static>`](https://github.com/vadimdemedes/ink#static), which writes them
once into the terminal's *native* scrollback (scrollable, never repainted) — the
same effect as pi-tui pushing committed lines above its viewport. Only the current
turn plus the input/status chrome stay in the managed region, so a chunk repaints
one entry, not the whole tree. The frontend marks the boundary via the App's
optional `commitScrollback()` (called when a new turn begins); the current turn
stays fully interactive (expand, toggle-thinking, group-merge), and completed turns
become frozen history. Clearing the chat (fork / session switch) unmounts, wipes the
screen *and* scrollback buffer, and remounts, since `<Static>` content can't be
un-written.

It implements the full `Renderer` contract from `@guanyilun/ashi/renderer` and is
verified headlessly with `ink-testing-library` (`npm test`).

### Inspecting the render flow

Set `ASHI_INSPECT` to debug render loops (the kind that surface as React's
"Maximum update depth exceeded"). It writes append-only JSONL of: the warning and
its stack, any **re-entrant store bump** (a bump fired during a flush — the
setState-in-effect loop signature), and **render bursts** (many commits in a tight
window, via a `Profiler`). Off unless set; disables Ink's console patching while on
so the warning reaches the inspector.

```bash
ASHI_INSPECT=1 ASHI_RENDERER=ink npm run dev -- -e ashi-ink   # → $TMPDIR/ashi-inspect.log
ASHI_INSPECT=/tmp/ashi.log ASHI_RENDERER=ink npm run dev -- -e ashi-ink
```

## Capability notes (vs pi-tui)

This is a demonstration renderer; some shell affordances degrade:

- **No inline images** (`capabilities.images = false`).
- **Editor autocomplete** and the **dynamic border color** for shell mode aren't
  wired (`ink-text-input` has no native autocomplete; shell mode still shows in the
  status footer).
- **Key release/repeat** aren't distinguished (Ink delivers line-mode keys), and
  Ctrl+Z **suspend/resume** is best-effort.

Content rendering, tool calls/results, diffs, markdown, the session/fork pickers,
the loader, and the core keybindings work.
