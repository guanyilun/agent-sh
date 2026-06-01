# ashi UI surfaces

How an extension drives ashi's terminal UI — post a notice, add a status-bar segment, pin a
widget above the input, or ask the user a question.

ashi doesn't hand extensions a `ui` object. Instead it answers a small set of **bus events**
and **named handlers**, so the same extension degrades gracefully under a frontend that doesn't
implement a given surface (and under headless/RPC use). There are three shapes:

- **Notices** are fire-and-forget bus events (`ctx.bus.emit`).
- **Status segments and docks** are *pull* pipes (`ctx.bus.onPipe`): ashi asks for contributions
  while it repaints and you append yours — ashi owns the layout.
- **Dialogs** are request/response calls (`await ctx.call(...)`) that resolve when the user answers.

## Setup

For typed events, import the augmentation once (types only — no runtime cost):

```ts
import "@guanyilun/ashi/events";
```

`ui:*` names are meant to work under any ashi-compatible frontend; `ashi:*` names are specific to
ashi's terminal UI. Before a `ctx.call(...)` that must return a value, feature-detect:

```ts
if (ctx.list().includes("ui:select")) { /* … */ }
```

Bus emits (`ui:notify`, the `*:invalidate` nudges) need no detection — they're no-ops when nothing
is listening.

## Timing

Extensions load before ashi mounts, so the surfaces aren't all live at `activate()` time:

- **Pull contributors (`status`, `dock`, any `onPipe`) can be registered any time** — ashi reads them
  on its next repaint, so registering during `activate()` is fine; the first paint picks them up.
- **Imperative surfaces (notify, dialogs, editor) are ready once ashi has mounted.** From a command
  or key handler they're always ready. To use one at startup, wait for the `ashi:ready` event:

  ```ts
  ctx.bus.on("ashi:ready", () => createUi(ctx).notify("loaded"));
  ```

The helper degrades (`select`/`input` → `undefined`, `confirm` → `false`) if called before a frontend
answers, so a premature call can't throw; a premature `notify` is simply dropped.

## Post a notice

```ts
ctx.bus.emit("ui:notify", { message: "Saved.", level: "success" });
// level: "info" (default) | "warn" | "error" | "success"
```

Appends a themed line to the transcript.

## Add a status-bar segment

Contribute to the footer; ashi appends your segment and owns placement:

```ts
ctx.bus.onPipe("ui:status", (p) => ({
  segments: [...p.segments, { id: "build", text: "✓ build ok", color: "success" }],
}));
```

A segment is `{ id: string; text: string; color?: ThemeColor }`, where `ThemeColor` is a theme name
such as `"accent"`, `"success"`, `"warning"`, `"error"`, or `"muted"`. When your data changes
outside a repaint, ask ashi to re-pull:

```ts
ctx.bus.emit("ui:status:invalidate", {});
```

## Pin a widget above the input

Same pull model, but you build the view from the renderer's node factory (so you never import a
TUI library):

```ts
ctx.bus.onPipe("ashi:dock:above-input", (p) => {
  const line = p.nodes.text({ paddingX: 1 });
  line.setText("📌 2 todos remaining");
  return { ...p, views: [...p.views, line.node] };
});

// after a change:
ctx.bus.emit("ashi:dock:invalidate", {});
```

`p.nodes` offers `text`, `markdown`, `container`, `spacer`, and `image`. Return the payload
unchanged to contribute nothing — the dock takes zero space when empty.

## Ask the user

```ts
const fruit = await ctx.call("ui:select", {
  title: "Pick a fruit",
  items: [
    { value: "apple", label: "Apple", description: "crisp" },
    { value: "banana", label: "Banana" },
  ],
});                      // → the chosen value, or undefined if cancelled

const ok = await ctx.call("ui:confirm", { title: "Delete it?" });   // → boolean

const name = await ctx.call("ui:input", {
  title: "Name?",        // hint shown above the input
  prefill: "untitled",   // optional starting text
});                      // → the text, or undefined if cancelled (Esc)
```

Only one dialog (or built-in picker) is open at a time; a call made while one is open resolves
`undefined`.

## Read or seed the input

```ts
const draft = ctx.call("ui:editor:get-text") as string;
ctx.call("ui:editor:set-text", "/commit ");
```

## Typed helper

If you're willing to depend on `@guanyilun/ashi`, `createUi(ctx)` wraps everything above with
full types and no magic strings. Request/response surfaces also degrade on their own — `select`
and `input` resolve `undefined`, `confirm` resolves `false` — when no frontend answers:

```ts
import { createUi } from "@guanyilun/ashi/ui";

const ui = createUi(ctx);
ui.notify("Saved.", "success");
const fruit = await ui.select({ title: "Pick", items: [{ value: "a", label: "Apple" }] });
const seg = ui.status(() => ({ id: "build", text: "✓ ok", color: "success" })); // seg.refresh() / seg.remove()
const widget = ui.dock((nodes) => {
  const t = nodes.text({ paddingX: 1 });
  t.setText("📌 note");
  return t.node;
});
```

The raw events and calls above carry no build-time dependency on ashi — reach for them if you
want a dependency-free extension. The helper is the same protocol with types and degradation
bolted on.

## Not yet available

Floating/overlay panels and fully custom interactive components aren't exposed — the renderer
contract has no free-placement layer yet. Use the dock, dialogs, and notices above.

## Working example

[`ashi-ui-demo.ts`](../../ashi-ui-demo.ts) exercises every surface through the typed helper. Load
it and try the commands:

```
ashi -e ashi-ui-demo
/ui-demo        # select → confirm → input, then a notice
/ui-demo-bump   # update the status segment
/ui-demo-dock   # toggle the pinned widget
```
