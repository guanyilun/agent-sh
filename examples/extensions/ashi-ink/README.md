# ashi-ink

An [Ink](https://github.com/vadimdemedes/ink) (React) renderer for [ashi](../ashi),
shipped as an extension. It registers `ashi:renderer:ink`; selecting it swaps ashi's
entire TUI from pi-tui to Ink without changing ashi itself — the demonstration that
ashi's renderer is a swappable extension point.

## Use

From source (development):

```bash
cd examples/extensions/ashi-ink
npm install && npm run build
ASHI_RENDERER=ink ashi -e ashi-ink
```

`-e ashi-ink` *loads* the extension (registering `ashi:renderer:ink`) and
`ASHI_RENDERER=ink` *selects* it. Loading and selecting are separate steps.

Persistent setup (no per-command flags):

```bash
ashi install ashi-ink            # auto-loads on every launch
# then in ~/.agent-sh/settings.json: { "ashi": { "renderer": "ink" } }
```

Selection precedence: `--renderer ink` > `ASHI_RENDERER=ink` > `ashi.renderer` in
settings > `pi-tui` (default).

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
