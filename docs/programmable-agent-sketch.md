# Programmable agents: architecture and API

The programmable runtime is implemented at `agent-sh/runtime`. The historical
filename of this guide is retained; this is an implementation guide, not a proposal.
It composes an owned extension host with the **same full ash `AgentLoop`**, rather
than introducing a separate reduced loop for scripts or children. It does not imply
that existing frontends have migrated to the callable host API.

Run the repository demo (Node 22+, dependencies installed):

```sh
node --import tsx examples/programmatic-agent.ts
```

Only the model transport is scripted. The demo runs the real `ashEngine` tool loop,
checks tool advice and instructions, runs two hosts concurrently, restores a
snapshot after a follow-up, denies a child's delegated tool at the parent policy
boundary, and verifies disposal of both hosts. It needs no credentials or network
and accesses no project files. A denied tool result is visible to the model; it
does not necessarily make the overall run fail.

## Architecture: one engine, shared extension surface

```text
script / workflow / optional frontend
                  │
           createAgentHost
       run / steer / cancel / snapshot / restore / dispose
                  │
       instance-owned core + scoped extensions
       bus, handlers/advice, cwd, settings service
                  │
      ashEngine                  legacy event backend
      agent:run                  agent:submit → processing-done
          │
      full AgentLoop (also used by activateAgent and runSubagent)
      prompt/context → streamed model → tool protocol → tool batch → repeat
          │
      tool:execute                 ← policy/permission advice
          │
      tool:dispatch                ← injectable executor
          │
      tool:<name>                  OR process JSONL executor
      per-tool advice + execute       worker-owned tool allowlist
```

`ashEngine` attaches the shared agent surface, binds an explicit `LlmClient`,
registers supplied tools/instructions and the `ash` backend, then starts `AgentLoop`.
The loop retains normal prompt construction, extension context hooks, streaming,
usage accounting, tool protocols, retries, steering, cancellation and compaction
hooks. It records assistant/tool messages and repeats model requests until a final
answer, cancellation, limit or failure. Model capabilities and configured extensions
still determine which features are available; composing the engine does not load
all CLI extensions.

The shared surface is not a second extension framework. A `HostExtension` is
`{ name: string, activate(ctx): void | Promise<void> }`, with the same
`ExtensionContext` used elsewhere:

- `ctx.bus`: events, pipes, async pipes and transforms; usable for progress rendering.
- `ctx.define`, `ctx.call`, `ctx.advise`, `ctx.list`: named handlers and advice.
- `ctx.agent`: tool registration/advice/schema advice, instructions, skills,
  context producers, provider registrations and an LLM facade. `ashEngine` attaches
  it before later extensions activate.
- `ctx.onDispose`: scoped cleanup; registrations/listeners/advice are tracked by
  the existing extension loader.
- `ctx.shell`: optional and absent unless a shell host explicitly supplies it.
  Extensions requiring terminal/compositor/UI capabilities need those capabilities;
  a headless host does not synthesize them.

Extensions activate in the supplied order. Existing activation functions can be
wrapped as `{ name, activate }`. There is no automatic user-module discovery, shell,
slash-command set, renderer set or frontend. All in-process extensions are trusted
JavaScript, not sandboxed plugins.

## Explicit model setup

This example calls a real OpenAI-compatible model. The host, engine composition,
and model client are all exported from `agent-sh/runtime`.

```ts
import { createAgentHost, ashEngine, localTools, LlmClient } from "agent-sh/runtime";

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) throw new Error("Set OPENAI_API_KEY");
const client = new LlmClient({
  apiKey,
  model: "gpt-4.1-mini",
  baseURL: "https://api.openai.com/v1",
});
const host = await createAgentHost({
  cwd: process.cwd(),
  settings: { autoCompact: false, toolMode: "api" },
  extensions: [
    ashEngine({
      client,
      model: { id: client.model, provider: "openai" },
      instructions: "Explain findings concisely; do not invent file contents.",
      ambientContext: false,
    }),
    // Optional: omit this extension for a host with no filesystem tools.
    localTools({ names: ["read_file", "grep", "glob", "ls"] }),
  ],
});
try {
  const result = await host.run("Inspect package.json and explain the build command", {
    maxIterations: 6,
    budgetTokens: 3000,
  });
  console.log(result.status, result.text);
} finally {
  await host.dispose();
}
```

`LlmClient` owns model transport configuration and credentials. `fork(overrides)`
creates an independent client; sharing a mutable client deliberately can couple
sessions if one reconfigures it or switches models. The runtime performs **no
implicit provider discovery** on this explicit path. Hermetic composition means
supplying the client, settings, extensions and capabilities explicitly; it is not
an OS isolation guarantee. Model requests still use the configured network endpoint.

### `ashEngine(options)`

| Option | Behavior |
|---|---|
| `client` | Required `LlmClient`; no provider/key lookup is performed for you |
| `model` | Optional model/capabilities; defaults to `{ id: client.model, provider: "custom" }` |
| `endpoint` | Optional endpoint metadata/hooks, e.g. provider reasoning/cache-usage decoding; it does not replace configuring the client transport |
| `tools` | Explicit `ToolDefinition[]`; no local tools are implicit |
| `instructions` | Registers a `host` instruction section |
| `ambientContext` | **Defaults to `false`**; opt into CLI-style global/project prompt and skill discovery with `true` |
| `executor` | Optional `AgentToolDispatcher`, installed as `tool:dispatch` inside `tool:execute` policy |

`ambientContext: false` disables ambient discovery, not explicitly registered
instructions, skills or context producers. Do not load an extension that discovers
files if that is unwanted. `activateAgent` and direct legacy `AgentLoop` setup
retain their compatibility defaults; the explicit runtime default is different.

### Optional local tools

`localTools({ names?, env? })` registers `read_file`, `write_file`, `edit_file`,
`grep`, `glob`, `ls`, and `bash` when bash is available. Omitted `names` selects all
available tools; an unknown/unavailable requested name throws during activation.
It uses the host's `cwd` handler without starting a shell frontend or changing
`process.cwd()`. Environment is copied at activation: omitted `env` copies
`process.env`, while an explicit object supplies the bash tool environment.
The environment option is not an OS-wide environment restriction on in-process
JavaScript. Tool selection and cwd are not a filesystem sandbox. Install permission
advice if confirmation or restrictions are needed; tools are not gated by default.

## Host API and ownership

```ts
const host = await createAgentHost({
  cwd: "/absolute/project/path",
  config: { backend: "ash" },
  settings: { autoCompact: false },
  extensions: [ashEngine({ client })],
});
```

- `cwd` and ordered `extensions` are required. `config` is the existing `AppConfig`;
  `config.backend` selects a registered backend. A missing backend fails creation.
- `settings` initializes an isolated, in-memory service from built-in defaults plus
  the supplied snapshot, **not** global settings files/environment overlays.
  `settingsService` can instead supply a deliberate service and takes precedence.
- `host.id`, `host.context`, `host.settings` expose instance identity, the extension
  context, and its settings service. Updates/session overlays on the default
  service do not write global files. `get()` and supplied snapshots are cloned.
- `run(query, options?)` allows one active run per host. Concurrent callers on one
  host reject as busy; callers own queueing. Different hosts can run concurrently.
- `steer(text)` requires an active run and queues input for the next tool boundary.
  It does not start a new turn. `cancel()` and `options.signal` request cooperative
  cancellation; arbitrary extension code cannot be forcibly interrupted in-process.
- `snapshot()` and `restore(snapshot)` require an idle, undisposed host and a
  backend implementing the corresponding handlers.
- `createChild(options)` creates an owned, explicitly composed host (see below).
- `dispose()` rejects future runs, requests cancellation, waits for owned children
  and the active run, calls native engine disposal, kills the backend, and cleans
  scopes in reverse order. It is idempotent, attempts remaining cleanup after
  errors, and reports cleanup failures. Initialization failure also cleans up.

Use `try/finally`. A non-cooperative legacy backend or arbitrary hanging extension
can leave run/disposal pending. Disposal is not a force-kill of all work started by
trusted JavaScript.

### Native run vs legacy event run

When `agent:run` exists, `host.run()` calls it directly with a single
`{ query, ...options }` input and an owned abort signal. It returns the correlated
engine result; unrelated completion events cannot settle that promise. Bus events
remain available for observation/progress. Avoid competing submit/reset/backend
switch calls during a host-owned run even on the native path.

For event-only backends the host subscribes **before** emitting `agent:submit`.
It accumulates usage, response/error/cancel events, and settles on
`agent:processing-done`. This compatibility path passes query/images and handles
abort, but does **not** implement native history, budgets, callbacks or other
engine options for that backend. Legacy events have no run correlation: unrelated
submits, auto-followups or completion events can violate ownership. A backend that
never emits processing-done can hang the adapter. Snapshot/restore are unavailable
unless that backend explicitly provides handlers.

`RunResult` contains `text`, `status` (`completed | cancelled | limited | failed`),
`usage`, optional `error`, and native-only `details`. Expected engine failures are
structured results; misuse/handler failures can still reject the promise.

### Native `AgentRunOptions` and `AgentRunResult`

The definitions live in `src/agent/run-contract.ts` and are exported as types from
`agent-sh/runtime`.

| Run option | Meaning |
|---|---|
| `runId` | Optional caller-supplied correlation ID |
| `images` | Base64 image inputs; declare image support on the model |
| `systemPrompt`, `dynamicContext` | Override the built prompt/context strings for this run |
| `history` | Defensively copied replacement wire history before appending the query |
| `maxIterations` | Maximum model rounds, unlimited by default; retries do not count |
| `budgetTokens` | Cumulative **completion** tokens, unlimited by default; checked between rounds, each request capped to remaining budget |
| `signal` | Cooperative cancellation |
| `shouldStop` | Sync/async predicate checked after a complete tool batch is recorded |
| `onMessage` | User/assistant/tool transcript notifications |
| `onUsage` | Per-response usage, not cumulative usage |
| `reasoningParams` | Explicit provider request parameters |
| `toolScheduling` | `parallel-readonly` (default) or `sequential` |
| `throwToolErrors` | Fail the run on thrown tool errors instead of recording an error tool result |
| `rawErrors` | Preserve original error text for compatibility callers |

`maxIterations` and `budgetTokens` must be non-negative safe integers; zero
permits no model work. Invalid limits reject the run promise.

Native `details` includes `runId`, `stopReason`, optional `limit`
(`iterations | budget | shouldStop`), cumulative `usage`, `iterations`, wire
`messages`, `mutatingToolExecuted` and optional `error`. `text` is **all assistant
text in the run**; `finalText` is only the latest round. `mutatingToolExecuted`
becomes true when a `modifiesFiles` tool reaches dispatch, including failed
attempts; it is not proof that files changed. Usage has prompt, completion and
total tokens plus optional `cached_tokens`; host usage also maps the cache count
to `cached_prompt_tokens` for bus compatibility. These are model-accounting limits,
not CPU, wall-clock, filesystem, network or monetary enforcement.

### Snapshots

`AgentSnapshot` is `{ version: 1, messages: ChatCompletionMessageParam[] }`:
wire conversation history without the per-request system/dynamic-context envelope.
Snapshot/restore copy the data; restore rejects unsupported versions. It is not a
serialization of extensions, settings, credentials, external files, in-flight work,
or executor state. Explicitly compose those again when restoring into another
host. Treat transcripts as potentially sensitive data.

## Children and delegated capabilities

Children are composition and lifecycle ownership, **not automatic security**.
`createChild` requires its own `cwd` and extension list. It copies the parent's
current settings snapshot plus child `settings` overrides into a fresh default
service, unless an explicit `settingsService` is supplied. It does not copy the
parent's context, conversation, tools, extensions or frontend. Sibling cancellation
is independent; parent disposal owns all created children, including children
whose initialization was in flight.

```ts
import { delegatedTools } from "agent-sh/runtime";

const child = await parent.createChild({
  cwd: "/project",
  extensions: [ashEngine({
    client: client.fork(),
    tools: delegatedTools(parent.context, ["read_file", "grep"]),
    instructions: "Review only. Report findings to the caller.",
  })],
});
const result = await child.run("Review the tests", { maxIterations: 5 });
// parent.dispose() will also dispose child; early child.dispose() is fine.
```

The parent must have these tools registered when `delegatedTools` is called, and
its active backend must expose `tool:execute` when they execute. Unknown names
throw; names are deduplicated and schemas are copied. No spawn/subagent tool or
other capability is added implicitly. `options.onProgress(name, chunk)` can observe
streamed output alongside the child's own callback.

Delegated execution calls **parent `tool:execute`**, preserving parent policy,
validation and the default dispatcher's per-tool advice. It never falls back to
parent `tool:dispatch` or a captured raw `tool.execute`, which would bypass policy.
The child's current call signal is forwarded, not a captured parent-run signal.
The parent does not need an active model run to enforce policy for a delegated call.

The model-facing schema list alone is not enforcement. Child extensions are trusted
code and could register new local tools or execute arbitrary JavaScript. For
untrusted code, use a real process/OS containment boundary with a trusted controller.
A custom `tool:dispatch` replaces local execution, so local `adviseTool` wrappers
are not guaranteed on that custom adapter; put mandatory cross-adapter policy on
`tool:execute` and enforce a worker allowlist as well.

### Legacy subagent compatibility

`runSubagent` (`agent-sh/agent/subagent`) is now a **compatibility adapter using the
same engine**, not a separate reduced model/tool loop. It creates a host with
`ashEngine`, forks real clients where supported, runs with sequential scheduling,
`autoCompact: false`, `toolMode: "api"`, and a default 20-round limit. It maps
legacy history/usage/message callbacks and output metadata, returns the latest
assistant text with legacy limit notices, throws on failed runs, and disposes its
host. Optional parent-bus forwarding is limited to legacy tool rendering events;
it does not share the child's bus or lifecycle. Explicit host composition remains
the API for owned children and capability delegation.

## Process tool executor: keep the model in the controller

`createProcessToolExecutor` replaces only tool execution. The trusted controller
keeps the model client and its credentials; policy still runs outside the executor
at `tool:execute`. The worker receives tool names/arguments, not client configuration,
tool implementations or schemas. Arguments themselves can still contain sensitive
data, so this is not automatic secret redaction.

A worker entry point uses `serveToolExecutor({ tools })` with its own fixed
`ToolDefinition[]`. For example, in a caller-created `worker.ts`:

```ts
import { serveToolExecutor } from "agent-sh/runtime";

await serveToolExecutor({ tools: [{
  name: "echo",
  description: "Echo a message",
  input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  async execute(args) {
    return { content: String(args.text), exitCode: 0, isError: false };
  },
}] });
```

The controller registers a matching model-facing tool definition (its `execute`
can throw to catch accidental local use), and supplies the dispatcher:

```ts
import { createProcessToolExecutor } from "agent-sh/runtime";

const executor = createProcessToolExecutor({
  command: process.execPath, // For containment, use your OS sandbox wrapper instead.
  args: ["--import", "tsx", "/absolute/path/to/worker.ts"],
  cwd: "/project",
  env: {}, // Deliberately do not inherit model keys or other controller secrets.
});
try {
  const host = await createAgentHost({
    cwd: "/project",
    extensions: [ashEngine({ client, tools: [echoDefinition], executor: executor.dispatch })],
  });
  try { await host.run("Echo hello", { maxIterations: 3 }); }
  finally { await host.dispose(); }
} finally {
  await executor.dispose(); // Executor lifetime is caller-owned, not auto-disposed by ashEngine.
}
```

Here `client` and `echoDefinition` are controller-owned values, and `tsx` must be
resolvable by the worker launcher (or compile the worker and run its JavaScript).
You may register executor disposal with `ctx.onDispose` instead of the outer
`finally`. `ProcessToolExecutorOptions` accepts `command`, `args`, `cwd`, `env`, a
lifetime `signal`, `shutdownTimeoutMs`, `maxMessageBytes` and `maxQueuedBytes`.
`command`/`args` go directly to `spawn` with `shell: false`; shell quoting is not
interpreted. **Omitting `env` inherits the controller environment**, including any
credentials in it.

### JSONL protocol and shutdown

stdin/stdout carry one JSON object per line, with string IDs unique among active
requests. stdout is protocol-only; diagnostics belong on stderr (inherited by the
controller). `serveToolExecutor` can also take caller-owned `input`/`output` streams.

```text
controller → { id, type: "execute", name, args }
controller → { id, type: "cancel" }
worker     → { id, type: "chunk", chunk: string }
worker     → { id, type: "result", result: ToolResult }
worker     → { id, type: "error", error: string }
```

The worker rejects unknown names and supplies a per-call `AbortController`.
`ToolResult` contains `content` (string or image array), `exitCode` (number or null)
and `isError`. An error reply rejects dispatch; `isError: true` remains a result.
Cancellation is cooperative: worker tools must honor `context.signal`. Interactive
UI capabilities do not cross the boundary. EOF aborts active worker calls; the
server does not end caller-owned streams. Default limits are 1 MiB per UTF-8 message
(excluding newline) and four message sizes of queued output. Malformed/truncated
frames and output overload fail closed instead of buffering indefinitely.

Executor disposal cancels pending calls, rejects further dispatch, sends SIGTERM,
then SIGKILL if needed, with a default 1000 ms grace period **for each** signal. It
waits for the direct child to exit or reports failure after bounded waits. It does
not provide process-tree containment.

**A separate process is not an OS sandbox.** The caller must choose a suitable
sandbox command wrapper and configure filesystem mounts, network restrictions,
user privileges, credential/env filtering, resource limits and process-tree
termination. The worker's allowlist does not restrict arbitrary worker JavaScript.
Keeping the LLM in the controller is a tool-execution boundary, not whole-agent
isolation.

## Compatibility defaults and remaining constraints

- The explicit `ashEngine` path avoids implicit provider discovery and ambient
  prompt/skill discovery by default. `createAgentHost` supplies instance settings,
  bus, handlers, cwd and conversation, but is not a general virtualization layer.
- Choosing `{ name: "ash", activate: activateAgent }` instead opts into the existing
  bootstrap: provider/auth resolution, built-in local tools and ambient behavior.
  The compatibility/global settings adapter and provider/auth home locations still
  exist as defaults in that ecosystem. `CONFIG_DIR`/`AGENT_SH_HOME` is resolved at
  module load; some provider SDKs/auth stores have their own home paths. Do not
  claim that host-local settings make that path hermetic or that changing a host's
  cwd relocates all state. Deliberately injected shared services can also share state.
- In-process extensions can read `process.env`, access files and spawn work. Neither
  advice nor hiding schemas can contain malicious JavaScript. Tool input validation
  is not a complete JSON Schema validator or a sandbox.
- Scope cleanup removes tracked listeners, advice, surface contributions and
  callbacks; it is not transactional rollback of every `define()` base handler.
  Do not keep using a disposed context. Per-extension hot unload/reload is not a
  host API here, and process-global module discovery is not added by this API.
- Snapshot format captures conversation only; it is not durable session/executor
  recovery or per-run OS resource accounting. Legacy event backends retain the
  correlation/termination limits described above.

For the lower-level kernel integration and compatibility bootstrap, see
[Using agent-sh as a Library](library.md). Nothing here requires a frontend migration.
