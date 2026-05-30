# ashi-ink

An [Ink](https://github.com/vadimdemedes/ink) (React) renderer for [ashi](../ashi),
shipped as an extension. Loading it registers `ashi:renderer:ink`; selecting it
swaps ashi's entire TUI from the default (pi-tui) to Ink. ashi's renderer is a
swappable extension point, and this is a working second implementation of it.

The look follows Claude Code's chat design: a `❯` user prompt on a faint band, a
`⏺` bullet for each assistant turn and tool call (green / red / blinking by status),
read & search groups that collapse to `Read N files`, and box-less diffs with a
line-numbered green/red gutter.

> Requires `@guanyilun/ashi` ≥ 0.2.0.

## Use

From source, inside the agent-sh repo — the npm workspace links the local
`@guanyilun/ashi`, so no published release is needed:

```bash
npm install                                   # once, at the repo root
npm run build -w @guanyilun/ashi -w ashi-ink
cd examples/extensions/ashi
ASHI_RENDERER=ink npm run dev -- -e ashi-ink
```

`-e ashi-ink` **loads** the extension; `ASHI_RENDERER=ink` **selects** it — loading
and selecting are separate steps.

Once `@guanyilun/ashi` ≥ 0.2.0 is published, set it up persistently instead:

```bash
ashi install ashi-ink            # auto-loads on every launch
# then in ~/.agent-sh/settings.json: { "ashi": { "renderer": "ink" } }
```

Selection precedence: `--renderer ink` > `ASHI_RENDERER=ink` > `ashi.renderer` in
settings > `pi-tui` (the default).

## What works, what doesn't

Content, tool calls and results, diffs, markdown, tables, the session/fork pickers,
and the loader all work. The input box is a real line editor: readline keybindings,
word motion (Alt+B / Alt+F), Shift+Enter for multi-line, and input history — it
reuses agent-sh's line editor over the same kitty-aware terminal input the default
renderer uses, so keys behave identically across the two.

Autocomplete and slash-command suggestions work too: the suggestion popup is a
substrate-owned primitive (a list in the `belowInput` slot) that this renderer just
draws, so it behaves the same here as in the default renderer.

As a demonstration renderer, a couple of affordances degrade:

- **No inline images.**
- Shell mode isn't color-coded on the input border (the status footer still indicates it).

It implements the full renderer contract from `@guanyilun/ashi/renderer`. The
rendering is verified headlessly with `ink-testing-library` (`npm test`); the
terminal input layer is shared with the default renderer.
