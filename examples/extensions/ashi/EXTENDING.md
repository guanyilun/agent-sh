# Extending ashi

Other extensions can customize how chat entries and tool results render — and even swap the whole TUI renderer — without forking ashi. For non-render concerns (commands, settings, tools, providers) use the standard `agent-sh` extension API; see the [agent-sh extension docs](https://github.com/guanyilun/agent-sh/blob/main/docs/extensions.md).

To **drive** the UI from an extension — post a notice, add a status segment, pin a dock widget, or open a select/confirm/input dialog — use the UI-surface protocol (bus events + named handlers, no `ctx.ui` object); see [`docs/ui-surface-protocol.md`](docs/ui-surface-protocol.md) and the worked example `examples/extensions/ashi-ui-demo.ts`.

## Chat hooks

These return a renderer-agnostic chat-entry view built from the active renderer's
node factories (`args.nodes`), so an override never imports a concrete TUI library:

| Hook | Args | Returns |
|---|---|---|
| `ashi:render-user-message` | `{ text, nodes, state, invalidate }` | `{ node }` |
| `ashi:render-assistant` | `{ text, nodes, state, invalidate }` | `{ node, appendText, appendCodeBlock, finalize, hasContent }` |
| `ashi:render-thinking` | `{ text, hidden, nodes, state, invalidate }` | `{ node, appendText, finalize, setHidden }` |

`nodes` is a `RenderNodes` (`text` / `markdown` / `image` / `container` / `spacer`); `src/chat/` holds the default controllers.

## Tool hooks — declarative render schema

Tool rendering uses a declarative schema so extensions don't import pi-tui or touch ashi internals. Register a `RenderModel` under `ashi:render-tool:{name}` (with `:default` as the fallback):

```ts
import type { RenderModel, ToolDisplay } from "@guanyilun/ashi/render";

const myModel: RenderModel<{ command: string }> = {
  initial: ({ rawInput }) => ({ command: JSON.parse(String(rawInput)).command ?? "" }),
  view: (s): ToolDisplay => ({
    title: [
      { text: "$ ", style: { bold: true, color: "toolTitle" } },
      { text: s.command, highlight: "bash" },
    ],
    status: s.status,
    body: { kind: "stream", text: s.output },
    expandable: true,
  }),
};

export default function activate(ctx) {
  ctx.define("ashi:render-tool:bash", () => myModel);
}
```

`view(state, env)` is a pure function returning a `ToolDisplay`. Ashi owns the mapping to the active renderer, theming, streaming buffer policy (preview / summary / hidden modes from `ashi.display`), diff width memoization, and the Ctrl+O expand toggle. The framework auto-tracks `state.status`, `state.output` (streaming chunks), and `state.hasDiff` (for edit/write) — renderers read these without wiring their own reducers.

`ToolDisplay` body kinds: `text`, `code` (with syntax highlighting via `lang`), `stream` (preview/summary/hidden policy applied by ashi), `diff` (closure pushed by the frontend orchestrator), `lines`, `compound`. Custom state transitions can be declared via an optional `reducers` map.

To ship a default display policy with your renderer (e.g. "this tool's output is large, default to `summary`"), set `display` on the model. User `settings.json` still wins:

```ts
const myModel: RenderModel<...> = {
  initial, view,
  display: { result: "summary", previewLines: 3 },
};
```

## Renderers

The whole TUI is swappable. ashi (the substrate) depends only on the `Renderer`
contract from [`@guanyilun/ashi/renderer`](src/renderer.ts) — the schema, theme,
chat controllers, and frontend never import a concrete TUI library. The built-in
renderer is pi-tui (`src/renderers/pi-tui`).

A renderer is just an extension that registers `ashi:renderer:<name>`:

```ts
import type { Renderer } from "@guanyilun/ashi/renderer";

function createMyRenderer(): Renderer { /* … */ }

export default function activate(ctx) {
  ctx.define("ashi:renderer:my-tui", () => createMyRenderer());
}
```

**Loading vs. selecting are separate.** A renderer must be *loaded* (so its
`ashi:renderer:<name>` is registered) and then *selected* by name:

- **Load** — `ashi install my-tui-renderer` (installed extensions auto-load every
  launch), or `-e my-tui-renderer` to load from source during development.
- **Select** — `--renderer my-tui` (flag) **>** `ASHI_RENDERER=my-tui` (env) **>**
  `ashi.renderer` in `settings.json` (persistent preference) **>** `pi-tui`
  (default). An unknown name errors rather than silently falling back.

So a persistent setup is `ashi install my-tui-renderer` once + `"ashi": { "renderer":
"my-tui" }` in settings — no per-command flags. The contract has two halves —
content-node factories (`text` / `markdown` / `image` / `container` / `spacer`) and
an app shell (`mount()` → scrollback / footer / queue / input / `belowInput` / status,
plus select lists, loader, and key events) — together with `mountToolCall` / `mountToolResult`
and a `capabilities` list so a renderer can declare gaps and the substrate degrades
rather than crashes. This is how you build a different TUI frontend (Ink, a
remote/web bridge…) without forking ashi.

Tool calls follow the same rule: the renderer owns the look. Same-kind runs of
`read`/`search` are collapsed by a substrate `ToolGroup` controller that owns only
the *state* (tail-merge, eviction, expand) and hands the renderer a neutral
`ToolGroupModel` to draw via the optional `mountToolGroup()`. The substrate ships
a default rendering — `renderToolGroupLines(model)`, the `├`/`└` tree — that a
renderer can mount as-is (both pi-tui and Ink do) or ignore and draw the model
however it likes. Grouping is a presentation policy, not a mandate: a renderer
that omits `mountToolGroup` opts out entirely, and the substrate renders those
calls individually through the schema mount.

Autocomplete works the same way: the substrate owns the popup and mounts the
suggestion list in the `belowInput` slot; the renderer only draws it, so the
slash-command / `@`-file popup behaves identically in every renderer.

The substrate also owns terminal setup so renderers don't each rediscover it.
agent-sh's shell clears OPOST on boot (pi-tui emits its own `\r`); ashi reads
`capabilities.rawOutput` and restores OPOST for renderers that emit lone `\n`
(Ink and most libraries — the default), so they don't staircase. A new renderer
gets the conventional terminal for free; only a raw driver like pi-tui sets
`rawOutput: true`.

See [`examples/extensions/ashi-ink`](../ashi-ink) for a worked example — a **working**
Ink (React) renderer (`ASHI_RENDERER=ink ashi -e ashi-ink`), verified with
`ink-testing-library`.
