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

## A deliberately distinct look

So you can tell at a glance which renderer is active, Ink uses its own visual
identity rather than mirroring pi-tui:

- each sent user turn on a **faint gray band with a violet `❯` marker** (the
  Claude Code pattern — stock Ink's `<Box>` can't fill a rect, but a padded
  `<Text backgroundColor>` does, once `marked-terminal`'s `\x1b[0m` resets are
  stripped so they can't punch a hole in the background),
- a violet **`▌` gutter bar** channeling every tool call and its output —
  including grouped `read`/`search` runs (Ink supplies `mountToolGroup`, so the
  group is drawn with the gutter instead of pi-tui's `├`/`└` tree),
- a **`❯` prompt** between top/bottom violet rules,
- content reflowed to the terminal width with each wrapped line indented one
  space, and a single violet accent (`#c778dd`) throughout.

The *content* (markdown, diffs, tool bodies) is the same ANSI the substrate
produces — only the chrome and framing differ, which is exactly the seam a
renderer owns.

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

It implements the full `Renderer` contract from `@guanyilun/ashi/renderer` and is
verified headlessly with `ink-testing-library` (`npm test`).

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
