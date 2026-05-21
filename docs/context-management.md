# Context Management

## What is "context," and why manage it?

Large language models take text as input and produce text as output. Every model has a **context window** — a hard cap on how much text it can consider at once, measured in tokens (~4 characters each). A modern frontier model might offer 200k or 1M tokens; an older one might offer 8k. The window is always finite, and every token inside it costs money, costs latency, and — as windows grow — can degrade output quality.

"Context management" is the art of deciding *what* to keep inside that budget, *when* to evict things, and *how* to recover what you've pushed out. Different agents solve this differently. Most chat-style agents sidestep it: you get one window per conversation, and when it fills up you start a new chat. That works when the agent owns the entire interaction.

**agent-sh is different — it lives inside a terminal**, and terminals don't have sessions.

## The terminal mental model

When you use a shell, you never think about "sessions." You run commands, switch between tasks, help a colleague, come back. Shell history is just *there* — always growing, searchable, persisting across restarts. Nobody invokes `/clear` or picks a new chat.

agent-sh adopts this mental model. The consequences shape everything below:

1. **No sessions.** There's no new-chat button and no `/clear`. History is continuous and append-only, like `.zsh_history`.
2. **No workflow guessing.** We don't try to detect topic changes or time gaps — any heuristic that guesses user intent will be wrong often enough to annoy. The only reason to evict content is mechanical: the window filled up.
3. **Two streams.** Shell activity and agent reasoning are fundamentally different kinds of information; they deserve different mechanisms.
4. **Model-aware where it matters.** Compaction triggers adapt to the model's real context window, not a hardcoded threshold.
5. **Strategy is pluggable.** The kernel decides *when* to act; *how* to compact is behind an advisable handler so extensions can install richer strategies without touching core code.

## The two streams

### Shell context — "what has the user been doing?"

Captured and owned by the `shell-context` built-in (`src/shell/shell-context.ts`). Tracks user-initiated PTY activity: shell commands the user ran + their outputs.

Agent tool outputs are **not** here — those live in the conversation stream. The boundary is strict: if the user typed it at the PTY, it goes into shell context; if the agent called a tool, it goes into the conversation.

Frontends without a PTY (e.g. agent-sh-hub) simply don't load this extension — the agent runs cwd-aware via the default `cwd` handler (`process.cwd()`) and no `<cwd>` / `<shell_events>` envelope is emitted.

### Conversation — "what has the agent been working on?"

The in-memory prompt being assembled this turn lives in a `LiveView` (`src/agent/live-view.ts`). This is the OpenAI-shaped messages array (`user` / `assistant` / `tool`) the LLM actually sees. Contains:

- User messages (queries the user sent to the agent)
- Assistant messages (the LLM's replies)
- Tool calls and tool results

The two streams merge at one point: when the user submits a new query, the current cwd is wrapped inside `<cwd>` and any new shell events inside `<shell_events>` (both nested in the per-query `<query_context>` envelope) and prepended to that user message. They then live inside the conversation array as regular bytes, but they are never stored separately in both places.

## How shell activity reaches the LLM

Each exchange (a shell command + output) gets a sequential `id` as it's captured. The shell-context extension keeps an internal `lastSeq` cursor — the highest id it has already sent to the model.

Shell context is registered as a per-query context producer (`ctx.agent.registerContextProducer("shell-context", …, { mode: "per-query" })`):

1. The producer always emits `<cwd>...</cwd>` with the live PTY-tracked cwd, so every user message anchors where the agent is right now (immune to compaction confusion over historical cwds).
2. If there are exchanges with id > `lastSeq`, it appends `<shell_events>...</shell_events>` with the deltas; the cursor then advances to the new high-water mark.
3. The dispatcher composes the result with any other per-query producer output and wraps the whole bundle in `<query_context>...</query_context>`, prepended to the user's query inside a single user message.

The delta is sent **once per user query**, not per tool-use step inside the agent loop. Inside the loop (where the LLM calls tools, sees results, calls more tools), no new shell events are injected — injecting mid-loop would break the `tool_call → tool_result` chain some providers require, and per-tool-call shell visibility isn't the right semantic anyway.

Prior-turn shell events remain visible in later turns because they're embedded in earlier user messages in the conversation history. They are not *re-sent* as fresh bytes — the provider's prefix cache amortizes them to O(1) per turn.

## Handling long shell outputs

A `find /` or a verbose build can produce megabytes of output. Storing that verbatim in context is wasteful: most of it is never referenced.

At capture time, if an exchange's output exceeds `shellTruncateThreshold` lines:

1. The full text is written to `<tmpdir>/agent-sh-<pid>/<id>.out`.
2. The in-memory exchange keeps only `shellHeadLines` from the top + a marker + `shellTailLines` from the bottom:
   ```
   <first 10 lines verbatim>
   [... 4823 lines truncated — full output at /tmp/agent-sh-12345/42.out; use read_file to expand ...]
   <last 10 lines verbatim>
   ```
3. If the agent needs the full content later, it calls `read_file` on the path — with `offset`/`limit` for pagination on very large files.

This trades a little disk I/O for a lot of heap and token savings, and gives the user a side benefit: they can `cat /tmp/agent-sh-<pid>/42.out` directly to inspect what was captured, which is handy for debugging.

The session directory is removed on process exit (including `SIGINT` / `SIGTERM` / `SIGHUP`). Stale directories from crashed sessions are swept lazily the next time agent-sh starts.

## Conversation compaction

Unlike shell context — which is a per-query delta and stays small — the conversation grows every turn. Without an active strategy it would eventually blow past the model's window. agent-sh splits this into a thin **kernel trigger** plus a swappable **strategy**, built on the [history substrate](history-substrate.md): `LiveView` (the in-memory prompt) and a named `Store` (durable append-only log).

### The substrate, in one paragraph

The kernel owns the `LiveView` and the `conversation:message-appended` event. A *strategy* — a built-in or user extension — subscribes to the event to capture entries into a `Store` it registered, and advises `conversation:compact` to mutate the `LiveView` when the kernel decides space is needed. The substrate API (`Store.append`, `findById`, `readRecent`, `search`) is append-only; strategies cannot delete history, only add to it. Bulk retention (front-truncation by size cap) is a property of the concrete `Store` implementation, not the API. See [History Substrate](history-substrate.md) for the full design.

### Kernel role — the auto-compact trigger

Before each LLM call, the kernel estimates prompt tokens (`conversation:estimate-prompt-tokens`) against `autoCompactThreshold × (contextWindow − responseReserve)`. If over budget — or if `/compact` is invoked, or the API returns a context-overflow error — it fires the `conversation:compact` handler. The kernel does not know how compaction works; it only knows when to ask.

### Default strategy — the `summary-strategy` built-in extension

Lives at `src/agent/extensions/summary-strategy/`. Two pieces:

**Capture (Tier 1)** — subscribes to `conversation:message-appended` and, for each new message, computes a one-line summary plus an optional capped body and `append`s it to its `Store`. The Store registers under the name `"summary"`; on-disk it's a `SharedFileStore` (multi-writer JSONL with `O_APPEND` atomic writes and lock-based front-truncation) at `~/.agent-sh/summary-strategy/history.jsonl`. The matching full message is also written to the Store with `{ ephemeral: true }` under `kind: "recall-cache"` — kept in memory only, recoverable during the session, gone after restart. Read-only tool results (`read_file`, `grep`, `glob`, `ls`) skip the durable summary because the agent can just re-run the tool.

**Compact (Tier 2)** — when the kernel fires `conversation:compact`, the advisor:

1. Pins the first turn verbatim (earliest user intent usually matters)
2. Pins the last few turns verbatim (the live focus)
3. Slims the next slice of recent turns (drops read-only tool calls, caps long bodies)
4. Scores the remaining middle by *priority × recency* and evicts lowest-priority first
5. Evicted turns collapse into a single synthetic `[Conversation history — use conversation_recall to expand any entry]` block built from `Store.readRecent()`

Each evicted message links to its summary entry via `meta.entryId`. That id is what `conversation_recall { action: "expand", turn_id }` looks up.

### Recall

The `recall:search` / `recall:expand` / `recall:browse` handlers are registered by the `summary-strategy` extension and read from its `Store`. The `conversation_recall` tool is a thin wrapper over them. To swap the recall backend, replace the extension (or advise the recall handlers).

### Token accounting

Compaction decisions use **API-grounded** token counts, not a chars/4 heuristic. After each API response, the provider's reported `prompt_tokens` is captured as an anchor. On the next iteration, `estimatePromptTokens()` returns that anchor plus a small local estimate for anything appended since. This keeps the trigger aligned with what the provider actually bills.

## Two mechanisms that look similar but aren't

People often conflate shell output truncation and conversation compaction. They're different things:

| | Shell output truncation | Conversation compaction |
|---|---|---|
| **Stream** | Shell context (`<shell_events>` deltas) | Conversation messages array |
| **When** | Once, at the moment each exchange is captured | On threshold crossing, `/compact`, or overflow retry |
| **State change** | Permanent: `ex.output` becomes head+tail+path | Permanent: evicted turns collapse to one-liners |
| **Full-text location** | Tempfile on disk | Ephemeral recall cache in memory + summaries in `~/.agent-sh/summary-strategy/history.jsonl` |
| **Recovery tool** | `read_file` on the spill path | `conversation_recall` |

They fire independently. An exchange with a huge output spills as soon as it's captured; conversation compaction may not trigger until many turns later, for unrelated reasons.

## Recall APIs

Both streams offer a way to retrieve full content that isn't in live context.

### Shell output — `read_file` on the spill path

There's no dedicated shell-recall tool: the spill file is just a normal file. The agent uses `read_file`, which already supports `offset`/`limit` pagination for very large outputs.

### Conversation — `conversation_recall` tool

Registered by the built-in agent; delegates to handlers owned by the `summary-strategy` extension:

- `conversation_recall {"action": "browse"}` — list recent summary entries from the Store
- `conversation_recall {"action": "search", "query": "..."}` — regex search across summary lines + bodies
- `conversation_recall {"action": "expand", "turn_id": "..."}` — full content of a specific entry (uses the `#<id>` token shown in the synthetic summary block)

Extensions that install a custom compaction strategy can reuse `conversation_recall` (via its underlying `recall:*` handlers) or advise it with their own semantics.

## Extension hooks

| Handler / event | Purpose |
|---|---|
| `conversation:compact` *(advisable handler)* | Install a custom compaction strategy. Read/mutate the live prompt via `ctx.agent.liveView`, append durable summaries to a `Store`, return `{ before, after, evictedCount }`. |
| `conversation:message-appended` *(event)* | Fires every time a message is added (user/assistant/tool). Capture-style strategies subscribe here to mirror entries into their `Store`. |
| `recall:search` / `recall:expand` / `recall:browse` *(handlers)* | Registered by `summary-strategy`; advise to add filtering, indexing, or alternate stores. |

Common override patterns: LLM-summarized compaction (summarize evicted turns before eviction), topic pinning (preserve turns matching pinned keywords), alternate persistence backends (SQLite, vector store, remote service). A strategy can also register its own named `Store` via `ctx.agent.registerStore("...", store)` if it needs a separate log (e.g. per-session full-fidelity transcripts).

## Slash commands

| Command | Action |
|---|---|
| `/compact` | Fire the `conversation:compact` handler (effective behavior depends on active advisors) |
| `/context` | Show context budget usage (active tokens, total tokens, budget) |

There's no `/clear` — history is continuous by design.

## Configuration

All settings live in `~/.agent-sh/settings.json`:

| Setting | Default | Description |
|---|---|---|
| `shellTruncateThreshold` | 20 | Output lines that trigger spill-to-tempfile at capture |
| `shellHeadLines` | 10 | Lines kept from the top when an output is spilled |
| `shellTailLines` | 10 | Lines kept from the bottom when an output is spilled |
| `autoCompactThreshold` | 0.5 | Fraction of available context window that triggers auto-compact |

The `summary-strategy` extension reads its own namespaced settings:

```json
{
  "summary-strategy": {
    "maxBytes": 209715200,
    "prefetchEntries": 50
  }
}
```

- `maxBytes` — front-truncation threshold for the summary log on disk. When unset, the `SharedFileStore` default applies. Truncation fires at 150 % of the cap and rewrites the file atomically (oldest entries first).
- `prefetchEntries` — number of recent summary entries to prepend to the live view at activate as a `[Prior session history …]` block. Default `50`; set to `0` for clean-start sessions. Hosts that own their own per-session model (e.g. ashi) typically don't activate this extension at all and so are unaffected.

## Key files

| File | Role |
|---|---|
| `src/shell/shell-context.ts` | Built-in: shell exchange capture, spill-to-tempfile on long outputs, `<shell_events>` per-query producer, `cwd` handler advisor |
| `src/utils/shell-output-spill.ts` | Per-pid session dir, cleanup on exit + signals, stale-dir sweep for crashed sessions |
| `src/agent/live-view.ts` | `LiveView` — in-memory prompt being assembled this turn (formerly `ConversationState`) |
| `src/agent/store.ts` | `Store` / `TreeStore` interfaces + `FileStore` (single-writer) / `SharedFileStore` (multi-writer) impls |
| `src/agent/store-registry.ts` | Named `Store` registry exposed as `ctx.agent.store(name)` / `registerStore(name, s)` |
| `src/agent/entry-format.ts` | Display line for synthetic summary blocks and `conversation_recall` output |
| `src/agent/nuclear-form.ts` | One-line-summary primitives (nucleate, priority classification) |
| `src/agent/extensions/summary-strategy/` | Default strategy: capture on `message-appended`, two-tier-pin compact, `recall:*` handlers |
| `src/agent/agent-loop.ts` | Auto-compact trigger, `conversation:compact` advisor chain, registers the `conversation_recall` tool |
| `src/agent/index.ts` | `/compact` and `/context` slash commands registered when the ash backend starts |
