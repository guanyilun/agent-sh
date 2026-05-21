# History Substrate

The history substrate is the set of primitives the agent uses to hold the prompt it is assembling this turn and to durably log what has been said. Two kernel-emitted events and three handles on `ctx.agent` let extensions write their own capture-and-compact strategy without changing the kernel.

The kernel's default strategy lives in [`src/agent/extensions/summary-strategy/`](../src/agent/extensions/summary-strategy/) and is itself a consumer of this surface — it claims no special privileges.

## The model

Three layers, two events, three handles.

### Three layers

| Layer | Role | Lifetime |
|---|---|---|
| **LiveView** | The prompt being assembled this turn — what the LLM sees | Per-turn, transient |
| **Store (in-memory)** | Queryable working set of entries — strategies and retrieval read from here | Process lifetime |
| **Store (on-disk)** | Durable record — append-only API, persistent | Retention-bounded by Store impl |

In-memory and on-disk are surfaces of one `Store` concept. By default they hold the same entries; the in-memory side may also hold *ephemeral* entries that intentionally don't persist (the summary strategy's `recall-cache` entries are this — full evicted messages kept in memory, never written to disk).

### What the Store guarantees, and what it doesn't

**Append-only.** The `Store` interface has no edit or delete operations. The only mutation is `append`. Strategies cannot point at an existing entry and request its removal. Compaction and other transforms can only *add* entries; they may append bookkeeping markers (boundary entries, summaries) but cannot modify what's already there.

**Bulk retention is impl-defined.** Concrete `Store` implementations may apply retention policy independent of strategies — front-truncation over a size cap, age-based GC, etc. `SharedFileStore` front-truncates above a configurable byte cap. That's a property of the implementation, not the API; the API doesn't promise infinite retention.

**Full-fidelity recovery is strategy-defined.** Whether the original conversation is recoverable from a Store depends on three independent choices:

1. *What the capture strategy wrote.* A summary strategy persists only summary lines + capped bodies; a verbatim-capture strategy persists full `AgentMessage`s.
2. *Durable vs ephemeral.* Entries written with `{ ephemeral: true }` live in memory only.
3. *Retention policy.* Entries inside the cap survive; entries front-truncated past it don't.

The summary strategy explicitly trades full recoverability for compactness and cross-instance economy. A verbatim strategy would explicitly preserve everything within retention. Both fit the same `Store` API.

### Two events

Strategies subscribe to two kernel-emitted events:

- **`conversation:message-appended`** — fires after every individual message is appended to the live view (user, assistant, tool). Payload includes the role and, for tool messages, structured `toolName`/`toolArgs`/`isError`. Capture-style strategies subscribe here.
- **`conversation:compact`** — invokable advisable handler. Strategies attach a lossy compaction algorithm via `ctx.advise("conversation:compact", ...)`.

Everything else — fork, resume, recall, search, branch-switch — is built by the host using the handles below. None of those are kernel events. Fork assumes tree shape; resume assumes a notion of "session"; recall assumes a strategy that holds back full content behind references. The kernel stays out of all of them.

### Three handles

Available on `AgentSurface` (`ctx.agent`):

```ts
ctx.agent.liveView                                // LiveView
ctx.agent.store(name: string): Store              // throws if not registered
ctx.agent.registerStore(name: string, s: Store)   // throws on name conflict
```

## The APIs

### LiveView

```ts
interface LiveView {
  get(): AgentMessage[];                // includes meta
  forLLM(): ChatCompletionMessageParam[]; // stripped of meta — what goes to the API
  replace(msgs: AgentMessage[]): void;
  estimateTokens(): number;             // conversation only
  estimatePromptTokens(): number;       // full prompt incl. system / tools / dynamic context
  link(index: number, entryId: string): void;
}
```

The LiveView is an array of messages with optional `meta`. Strategies write entry ids into `meta.entryId` via `link()` as the linkage convention. `estimateTokens()` and `estimatePromptTokens()` are distinct: compact strategies need both to subtract overhead and compare against the kernel's pressure signal.

### Store

```ts
interface Store {
  append(entries: Entry[], opts?: { ephemeral?: boolean }): Promise<void>;
  findById(id: string): Promise<Entry | null>;
  readRecent(n?: number): Promise<Entry[]>;
  search(query: string): Promise<{ entry: Entry; line: string }[]>;
}

interface TreeStore extends Store {
  getBranch(leafId?: string): Promise<Entry[]>;
  setLeaf(id: string): void;
  getLeaf(): string;
}

interface Entry {
  id: string;
  parentId?: string;
  ts: number;
  kind: string;                         // open enum
  payload: Record<string, unknown>;     // shape-by-kind
}
```

`Store` is the base capability — append, point lookup, recent scan, search. `TreeStore extends Store` adds parent-walking and an active-leaf pointer. The split is by interface, not optional methods: a value typed as `Store` is guaranteed not to expose tree operations.

`append(entries)` writes to both in-memory and on-disk; `append(entries, { ephemeral: true })` writes to in-memory only.

### Concrete implementations

Provided in `src/agent/store.ts`:

| Class | Shape | Notes |
|---|---|---|
| `NoopStore` | `Store` | Discards writes; useful for backends that don't need history. |
| `InMemoryStore` | `TreeStore` | Memory-only; loses everything on restart. |
| `FileStore` | `TreeStore` | Single-writer JSONL + `.leaf` sidecar. Per-session use. |
| `SharedFileStore` | `Store` | Multi-writer JSONL (O_APPEND atomic appends + lock-based front-truncation). For globally shared logs. Accepts `maxBytes` constructor option. |

`FileStore` exposes two sync-by-construction accessors (`getRootId()`, `size()`) outside the `Store` interface, because at construction time the file is read synchronously into memory.

### Capability narrowing

`ctx.agent.store(name)` returns `Store`. Strategies that need tree operations either cast or runtime-check:

```ts
import { isTreeStore } from "agent-sh/agent/store";

const s = ctx.agent.store("session");
if (!isTreeStore(s)) throw new Error("session store must be tree-shaped");
await s.getBranch();
```

`search` stays on the base interface — non-searchable stores return an empty array, which is semantically harmless. Tree shape is different because the operations fundamentally don't apply to linear stores.

### Async read semantics

`Store` reads (`findById`, `readRecent`, `search`, `getBranch`) are async. `SharedFileStore` reads stream the underlying file in reverse-chunked blocks, so the interface has to be async even though `FileStore` and `InMemoryStore` reads are pure in-memory.

### Entry shape

Open `kind` enum. Common kinds and their payloads:

| Kind | Payload shape | Used by |
|---|---|---|
| `"message"` | `{ message: AgentMessage }` | full-fidelity verbatim capture |
| `"user"` / `"agent"` / `"tool"` / `"error"` | `{ sum, body?, ... }` | summary capture (kernel default) |
| `"compaction"` | `{ firstKeptId, summary?, tokensBefore }` | contiguous-cut compact strategies |
| `"recall-cache"` | `{ fullMessage }` | the summary strategy's ephemeral recall layer |

Strategies choose which kinds to write. The Store is agnostic.

### Linkage between LiveView and Store

By **convention**, `liveMessage.meta.entryId` carries the id of the store entry the message was produced from. A capture strategy stamps it via `liveView.link(index, entryId)`; a compact strategy reads it to find `firstKeptId`. Synthetic messages (e.g. a compaction summary message inserted into the live view) have no `entryId`.

Not enforced by the kernel. `meta` is stripped by `liveView.forLLM()` before the API call.

## Conventions

Standing decisions worth knowing when authoring a strategy:

- **String ids throughout.** No numeric `seq` at the kernel level. Strategies that prefer numeric ids encode them as strings.
- **`parentId`-as-recall-link.** Ephemeral `recall-cache` entries set `parentId` to the durable summary entry they shadow. Recall becomes "find children of summary `X` with kind `recall-cache`," no separate index needed.
- **`meta.tool` on tool result messages.** The agent loop sets `m.meta.tool = { toolName, args, isError }` on tool result messages — strategies can read tool execution context off a flat live-message walk without reverse-engineering by `tool_call_id`.
- **Capture skips intermediate assistant messages.** An assistant message with `tool_calls` is *not* summarized — the resulting tool messages carry the meaning.
- **Store naming throws on conflict.** Two extensions registering the same name is a configuration error, not silent overwrite. Standard names are soft conventions (`"summary"`, `"session"`); hosts pick others freely.
- **Advisor cascade.** Calling `next(opts)` falls through to the next-registered advisor in chain order; if the chain ends with no advisor consuming, the call resolves to a no-op result (`null` for compact). Strategies that need a default should register the kernel's default last.
- **Multi-writer policy.** Per-session `FileStore` is single-writer (no locking needed). The multi-writer global summary file is a separate impl (`SharedFileStore`) using O_APPEND for atomic concurrent appends and a lock for front-truncation. Both implement the same `Store` interface.

## Example: a session-tree extension

A complete history extension that captures verbatim messages into a per-session tree and runs LLM-summarized contiguous compaction. One file, around 80 lines.

```ts
// session-tree-extension.ts
const KEEP_RECENT_TOKEN_BUDGET = 20_000;
const SUMMARY_PROMPT = `...`;

export default function activate(ctx: AgentContext) {
  const { agent } = ctx;

  const dir = ctx.getStoragePath("session-tree");
  agent.registerStore("session", new FileStore({ filePath: `${dir}/session.jsonl` }));

  ctx.bus.on("conversation:message-appended", async () => {
    const session = agent.store("session") as TreeStore;
    const msgs = agent.liveView.get();
    const idx = msgs.length - 1;
    const id = newEntryId();
    await session.append([{
      id, parentId: session.getLeaf(), ts: Date.now(),
      kind: "message",
      payload: { message: msgs[idx] },
    }]);
    session.setLeaf(id);
    agent.liveView.link(idx, id);
  });

  ctx.advise("conversation:compact", async (next, opts) => {
    if (!agent.llm.available) return next(opts);
    const session = agent.store("session") as TreeStore;
    const msgs = agent.liveView.get();

    const cutIdx = findCutPoint(msgs, KEEP_RECENT_TOKEN_BUDGET);
    if (cutIdx < 2) return next(opts);

    const firstKeptId = msgs[cutIdx].meta?.entryId as string | undefined;
    if (!firstKeptId) return next(opts);

    const older = msgs.slice(0, cutIdx);
    const kept  = msgs.slice(cutIdx);
    const tokensBefore = agent.liveView.estimateTokens();

    const summary = await agent.llm.ask({
      system: SUMMARY_PROMPT,
      query: buildQuery(older),
    });

    await session.append([{
      id: newEntryId(), parentId: session.getLeaf(), ts: Date.now(),
      kind: "compaction",
      payload: { firstKeptId, summary, tokensBefore },
    }]);

    agent.liveView.replace([
      { role: "user", content: `[Compacted conversation summary]\n${summary}` },
      ...kept,
    ]);

    return {
      before: tokensBefore,
      after: agent.liveView.estimateTokens(),
      evictedCount: older.length,
    };
  });
}
```

A deterministic variant differs in two lines: skip the LLM call, use a structural summary for the text, omit `summary` from the compaction entry's payload (re-render at read time instead).

## Trace: three turns + compaction

State after activation: LiveView `[system]`, session store has just the header.

**Turn 1 finishes**, agent loop appends `u1, a1` to LiveView and fires `conversation:message-appended` for each.

After capture:
- LiveView: `[system, u1{meta:{entryId:"x1"}}, a1{meta:{entryId:"x2"}}]`
- session (memory + disk): `[header, msg(x1), msg(x2)]`

**Turns 2 and 3** proceed identically. State after turn 3:
- LiveView: 7 messages, every non-system message tagged with its `entryId`
- session: `[header, msg(x1)..msg(x6)]`

**Budget exceeded → `conversation:compact` fires.** Compact strategy computes `cutIdx = 5`, reads `msgs[5].meta.entryId = "x5"`, runs the LLM, appends a `compaction` entry with `firstKeptId: "x5"`, calls `liveView.replace([summarySynthetic, u3{x5}, a3{x6}])`.

After compact:
- LiveView: `[system, {role:"user", content:"[Compacted...]\n##Goal..."}, u3{x5}, a3{x6}]`
- session: `[header, msg(x1)..msg(x6), compaction(x7)]` — all original messages preserved; one new marker entry

**On resume**, a host-side function walks the session branch, finds the latest compaction node, materializes LiveView as `[summary-synthetic, ...verbatim from firstKeptId onward]`. No kernel involvement.

## Out of scope (host concerns)

These are deliberately not kernel features:

- **A `Strategy` interface or bundle type.** Each handler registers independently against its hook point.
- **`fork` / `resume` / `recall` / `search` events.** Each makes assumptions (tree shape, session concept, summary references, agent-callable) that don't hold universally. Hosts compose them from the three handles.
- **`MultiSessionStore`** (per-cwd session listing, picker UI). Host-side policy.

See [Context Management](context-management.md) for how the kernel's default summary strategy is wired and configured.
