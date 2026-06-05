# Using agent-sh as a Library

## Library vs Extension

agent-sh has two integration points. The difference: **extensions customize the existing TUI**, while **library mode lets you build your own frontend**.

| | Extension | Library |
|---|---|---|
| **Use when** | You want to add features to the interactive terminal — themes, custom renderers, input modes, content transforms | You're building something else entirely — a REST API, Electron app, test harness, CI pipeline |
| **You get** | An `ExtensionContext` — substrate (bus, handlers, lifecycle, compositor) + slash-command registration + optional host surfaces. `ctx.agent` (LLM, tools, instructions) and `ctx.shell` (palette, transforms, remote sessions) are attached by their hosts during activation; under headless backends, the missing surface is `undefined`. Narrower types (`AgentContext`, `ShellContext`, or their intersection) let extensions declare which hosts they require. | `AgentShellCore` — bus, handler registry, lifecycle control (`activateBackend`, `kill`) |
| **Who controls the frontend?** | The built-in TUI does; you decorate it | You do; there is no TUI |
| **How to use** | Export an `activate` function, load with `-e` | Import `createCore()`, load extensions, wire your own I/O |

If you're adding a Mermaid renderer or a custom slash command, write an extension. If you're building a web server that talks to an LLM, use the library.

Two real frontends are built this way: [**ashi**](../examples/extensions/ashi/) (published as `@guanyilun/ashi`) drives `createCore()` into a standalone chat-style TUI with no shell underneath, and [**asHub**](https://github.com/firslov/asHub) wraps the same kernel in an Electron desktop app. Both reuse the ash backend, tools, and providers — only the frontend differs.

## Quick Start

```typescript
import { createCore } from "agent-sh";
import { activateAgent } from "agent-sh/agent";
import { loadBuiltinExtensions } from "agent-sh/extensions";

const core = createCore({
  // These are ash-backend config, not kernel config — see note below.
  provider: "deepseek",                 // built-in provider → DeepSeek endpoint + deepseek-v4-flash default
  apiKey: process.env.DEEPSEEK_API_KEY,
});

const ctx = core.extensionContext({ quit: () => process.exit(0) });

activateAgent(ctx);
const loaded = await loadBuiltinExtensions(ctx);
core.bus.emit("core:extensions-loaded", { names: loaded });

core.bus.on("agent:response-chunk", ({ blocks }) => {
  for (const b of blocks) if (b.type === "text") process.stdout.write(b.text);
});
core.bus.on("agent:processing-done", () => console.log("\n[done]"));

await core.activateBackend();
core.bus.emit("agent:submit", { query: "explain this codebase" });
```

`createCore()` returns a headless kernel — the event bus and handler registry, with no terminal, shell, LLM, or agent attached. `activateAgent(ctx)` attaches the agent surface (tools, LLM client, providers) and registers the built-in `ash` backend; `loadBuiltinExtensions(ctx)` adds the abstract backend registry, slash commands, and file autocomplete. `core:extensions-loaded` triggers provider resolution; `activateBackend()` then starts ash (or whichever backend is configured). Send queries by emitting `agent:submit` and consume responses by listening to bus events.

> **The LLM fields are backend config, not kernel config.** `createCore()` doesn't read `provider`/`apiKey`/`model`/`baseURL` — it stores the config object opaquely and re-exposes it through the `config:get-app-config` handler. The **ash** backend is the only consumer (`src/agent/index.ts`); it resolves the provider, key, and model from those fields. Under a different backend they're inert: `pi` reads `~/.pi/agent/settings.json`, `claude-code` uses its own SDK config — for those you pass `{ backend: "pi" }` (a real kernel field) and configure the model the backend's own way. The `AppConfig` type bundles kernel + agent + shell config into one object for convenience; the kernel only owns the `extensions` and `backend` keys (`CoreConfig`).

Tools run without confirmation by default; to gate them, register tool advisors via `ctx.agent.adviseTool` (see examples/extensions/interactive-prompts.ts).

## AgentShellCore API

| Method | Description |
|---|---|
| `bus` | The event bus — same one extensions use. See [Extensions: Event Bus](extensions.md#event-bus) |
| `handlers` | Named handler registry for `define`/`advise`/`call`. Core defines `cwd` (returns `process.cwd()`); shell-context advises it with the PTY-tracked value when loaded |
| `activateBackend(name?)` | Activates the named (or persisted-default) agent backend. Call after loading extensions and emitting `core:extensions-loaded` |
| `extensionContext(opts)` | Creates an `ExtensionContext` — use this to load extensions in library mode |
| `kill()` | Clean shutdown |

Send queries with `bus.emit("agent:submit", { query })`; cancel with `bus.emit("agent:cancel-request", { silent: false })`.

## Loading Extensions in Library Mode

Extensions aren't loaded automatically in library mode — you get a bare kernel with no agent. You must call `activateAgent` (for the ash agent surface) and load built-ins (for the backend registry):

```typescript
import { createCore } from "agent-sh";
import { activateAgent } from "agent-sh/agent";
import { loadBuiltinExtensions } from "agent-sh/extensions";
import myTheme from "./my-theme";

const core = createCore({ provider: "deepseek", apiKey: process.env.DEEPSEEK_API_KEY });
const ctx = core.extensionContext({ quit: () => process.exit(0) });

activateAgent(ctx);
const builtin = await loadBuiltinExtensions(ctx, ["slash-commands"]); // optionally disable
myTheme(ctx);
core.bus.emit("core:extensions-loaded", { names: builtin });

await core.activateBackend();
```

This is exactly what the CLI does internally: `createCore()` → `activateAgent()` → `loadBuiltinExtensions()` → user extensions → emit `core:extensions-loaded` → `activateBackend()`. The interactive terminal is just another layer on top of the same kernel.

See [Architecture](architecture.md) for details on the core design and EventBus.
