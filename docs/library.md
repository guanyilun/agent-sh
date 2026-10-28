# Using agent-sh as a Library

## Choose an integration level

For a callable agent in a script, service or workflow, start with
**`createAgentHost` + `ashEngine` from `agent-sh/runtime`**. It owns an extension
host and the full ash engine without a terminal frontend. See the
[programmable-agent architecture and API guide](programmable-agent-sketch.md)
for the complete run contract, settings, snapshots, children, delegation and process
executor boundary.

For lower-level event-driven integration, **`createCore()`** provides the kernel;
you attach a backend and wire your own I/O. The compatibility bootstrap example
below uses `activateAgent`, including its existing provider/auth initialization and
local-tool defaults. Neither integration level implies a migration of existing
frontends.

Extensions customize the host they are loaded into, not only the TUI. The same
agent tool, instruction and advice surface is available with `ashEngine`; extensions
requiring shell/UI capabilities still need a host supplying them. The following
table describes the lower-level kernel integration:

| | Extension | Library |
|---|---|---|
| **Use when** | You want to add features to the interactive terminal — themes, custom renderers, input modes, content transforms | You're building something else entirely — a REST API, Electron app, test harness, CI pipeline |
| **You get** | An `ExtensionContext` — substrate (bus, handlers, lifecycle, compositor) + slash-command registration + optional host surfaces. `ctx.agent` (LLM, tools, instructions) and `ctx.shell` (palette, transforms, remote sessions) are attached by their hosts during activation; under headless backends, the missing surface is `undefined`. Narrower types (`AgentContext`, `ShellContext`, or their intersection) let extensions declare which hosts they require. | `AgentShellCore` — bus, handler registry, lifecycle control (`activateBackend`, `kill`) |
| **Who controls the frontend?** | The built-in TUI does; you decorate it | You do; there is no TUI |
| **How to use** | Export an `activate` function, load with `-e` | Import `createCore()`, load extensions, wire your own I/O |

If you're adding a Mermaid renderer or a custom slash command, write an extension. If you're building a web server that talks to an LLM, use the library.

Two real frontends are built this way: [**ashi**](../examples/extensions/ashi/) (published as `@guanyilun/ashi`) drives `createCore()` into a standalone chat-style TUI with no shell underneath, and [**asHub**](https://github.com/firslov/asHub) wraps the same kernel in an Electron desktop app. Both reuse the ash backend, tools, and providers — only the frontend differs.

## Callable runtime quick start

Run the checked, deterministic source demo:

```sh
node --import tsx examples/programmatic-agent.ts
```

It uses `ashEngine` with a scripted OpenAI-shaped transport, **not a separate demo
backend**: real model/tool rounds, tool advice, concurrent parent/child hosts,
snapshot/restore, parent policy denial of delegated execution, and disposal are
all asserted. No credentials or network are required.

The runtime's explicit setup is:

```typescript
import { createAgentHost, ashEngine, localTools, LlmClient } from "agent-sh/runtime";

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) throw new Error("Set OPENAI_API_KEY");
const client = new LlmClient({ apiKey, model: "gpt-4.1-mini" });
const host = await createAgentHost({
  cwd: process.cwd(),
  settings: { autoCompact: false, toolMode: "api" },
  extensions: [
    ashEngine({ client, ambientContext: false }),
    // Optional; no local tools are implicit in ashEngine.
    localTools({ names: ["read_file", "grep", "glob", "ls"] }),
  ],
});
try {
  const result = await host.run("Explain package.json", { maxIterations: 5 });
  console.log(result.status, result.text);
} finally {
  await host.dispose();
}
```

This snippet calls a real model and needs credentials. The client controls its
endpoint (the OpenAI endpoint by default); the runtime does no implicit provider
discovery. `ambientContext` defaults to **`false`**: global/project prompts and
skills are not discovered unless explicitly enabled. Default host settings are
isolated and in-memory, not loaded from global files or environment overlays.
`settingsService` allows deliberate service injection.

| Host operation | Contract |
|---|---|
| `run(query, options?)` | One active run per host; different hosts can run concurrently. Native ash calls `agent:run` directly and returns structured status/usage plus `details` |
| `steer(text)`, `cancel()` | Steer an active run or request cooperative cancellation; `run` also accepts `signal` |
| `snapshot()`, `restore(snapshot)` | Idle-only, versioned wire history; not settings, credentials or executor state |
| `createChild(options)` | Owned child with explicit cwd/extensions, copied settings by default, no automatic tool/context inheritance or security boundary |
| `dispose()` | Idempotent cancellation/awaiting and backend/scope cleanup, including owned children |

Native runs support limits, history replacement and callbacks; event-only backends
use an `agent:submit`/`agent:processing-done` compatibility adapter without native
run details or automatic support for those options. See the
[full contract](programmable-agent-sketch.md#native-run-vs-legacy-event-run).
`runSubagent` is also a compatibility adapter over the same full ash engine, not a
second reduced loop.

For children, `delegatedTools(parent.context, names)` selects explicit parent
capabilities and executes through **parent `tool:execute` policy**, not a raw tool
body. Child composition itself is not a restriction on trusted extensions.
`ashEngine({ executor })` can replace `tool:dispatch` with a process JSONL executor
while keeping model transport/credentials in the controller and policy outside the
executor. An OS sandbox command wrapper, environment filtering and process-tree
containment remain the caller's responsibility; the process executor inherits the
controller environment if `env` is omitted. See
[execution and security details](programmable-agent-sketch.md#process-tool-executor-keep-the-model-in-the-controller).

## Lower-level kernel quick start (compatibility bootstrap)

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

`createCore()` returns a headless kernel — the event bus, handler registry and
backend registry, with no terminal, shell, LLM, or agent attached.
`activateAgent(ctx)` attaches the agent surface (tools, LLM client, providers) and
registers the built-in `ash` backend; `loadBuiltinExtensions(ctx)` loads optional
built-in features such as slash commands and file autocomplete.
`core:extensions-loaded` triggers provider resolution; `activateBackend(name?)`
then starts the selected or settings-default backend. Send queries by emitting
`agent:submit` and consume responses by listening to bus events.

> **The LLM fields are backend config, not kernel config.** `createCore()` doesn't read `provider`/`apiKey`/`model`/`baseURL` — it stores the config object opaquely and re-exposes it through the `config:get-app-config` handler. The **ash** backend is the only consumer (`src/agent/index.ts`); it resolves the provider, key, and model from those fields. Under a different backend they're inert: `pi` reads `~/.pi/agent/settings.json`, `claude-code` uses its own SDK config — for those you pass `{ backend: "pi" }` (a real kernel field) and configure the model the backend's own way. The `AppConfig` type bundles kernel + agent + shell config into one object for convenience; `CoreConfig` includes `extensions`, `backend`, and the injectable `settingsService` (`settings` is its alias). Without injection, `createCore()` uses the compatibility process-global settings service, unlike `createAgentHost()`'s isolated default. In this lower-level API, pass an explicit backend name to `activateBackend(name)` when selecting it directly.

This compatibility path retains existing global bootstrap/provider and auth-home
defaults; `activateAgent` is not the hermetic explicit-client path. Host-local
settings alone do not relocate provider SDK/auth stores or eliminate every global
compatibility service. Use the runtime setup above when you need explicit
composition with no implicit provider discovery.

Tools run without confirmation by default; to gate them, register tool advisors via
`ctx.agent.adviseTool` (see examples/extensions/interactive-prompts.ts). For policy
that must surround custom execution adapters as well, advise `tool:execute`;
`adviseTool` wraps the local named tool handler, not an arbitrary remote executor.

## AgentShellCore API

| Method | Description |
|---|---|
| `bus` | The event bus — same one extensions use. See [Extensions: Event Bus](extensions.md#event-bus) |
| `handlers` | Named handler registry for `define`/`advise`/`call`. Core defines `cwd` (returns `process.cwd()`); shell-context advises it with the PTY-tracked value when loaded |
| `activateBackend(name?)` | Activates the named (or persisted-default) agent backend. Call after loading extensions and emitting `core:extensions-loaded` |
| `extensionContext(opts)` | Creates an `ExtensionContext` — use this to load extensions in library mode |
| `kill()` | Clean shutdown |

Send queries with `bus.emit("agent:submit", { query })`; cancel with `bus.emit("agent:cancel-request", { silent: false })`. To add a message to a turn that is already running, emit `agent:steer` instead — ash injects it before the turn's next set of tool calls.

## Loading Extensions in Library Mode

With the lower-level `createCore()` API, extensions aren't loaded automatically —
you get a bare kernel with no agent. This compatibility recipe calls `activateAgent`
(for the ash agent surface/bootstrap) and loads built-ins. This is not required by
`createAgentHost`, which composes its explicitly supplied extensions and manages
backend activation itself:

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
