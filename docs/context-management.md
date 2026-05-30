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

Frontends without a PTY (e.g. ashi, asHub) simply don't load this extension — the agent runs cwd-aware via the default `cwd` handler (`process.cwd()`) and no `<cwd>` / `<shell_events>` envelope is emitted.

### Conversation — "what has the agent been working on?"

Owned by `LiveView` (`src/agent/live-view.ts`). This is the OpenAI-shaped messages array (`user` / `assistant` / `tool`) the LLM actually sees. Contains:

- User messages (queries the user sent to the agent)
- Assistant messages (the LLM's replies)
- Tool calls and tool results

The two streams merge at one point: when the user submits a new query, the current cwd is wrapped inside `<cwd>` and any new shell events inside `<shell_events>` (both nested in the per-query `<query_context>` envelope) and prepended to that user message. They then live inside the conversation array as regular bytes, but they are never stored separately in both places.

## How shell activity reaches the LLM

Each exchange (a shell command + output) gets a sequential `id` as it's captured. The shell-context extension keeps an internal `lastSeq` cursor — the highest id it has already sent to the model.

Shell context contributes to the per-query `query-context:build` handler (the `shell-context` extension advises it directly; extensions can equivalently use `ctx.agent.registerContextProducer(name, fn, { mode: "per-query" })`):

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

Unlike shell context — which is a per-query delta and stays small — the conversation grows every turn. Without an active strategy it would eventually blow past the model's window. The kernel owns the *trigger*; the **built-in `rolling-history` extension** owns the *strategy* and the *store*. The result is a three-tier scheme designed to feel like shell history. (Headless or bridge backends that don't load the extension keep the live array and the kernel trigger, but have no summary store, recall, or cross-restart history.)

### Tier 1 — eager capture

Every time a message is appended to the conversation, the kernel emits a `conversation:message-appended` event. The rolling-history extension listens and, for each message:

1. Nucleates it into a one-line summary (`nucleate()` in `src/agent/nuclear-form.ts`) and appends that as a persisted `Entry` to its summary **Store**.
2. Appends an *ephemeral* `recall-cache` child entry holding the full message, so the verbatim text stays expandable for the rest of the process without ever being written to disk.
3. Links the live message back to its entry id (`conversation:link`, which stamps `meta.entryId`), so a later compaction won't re-summarize it.

Read-only tool results (`read_file`, `grep`, `glob`, `ls`) are filtered out of the persisted summaries — the agent can just re-run those tools.

#### The summary store on disk

The store (`SharedFileStore` in `src/agent/store.ts`) is an append-only JSONL log at `~/.agent-sh/rolling-history/history.jsonl` (`~/.agent-sh` is the config dir, overridable via `AGENT_SH_HOME`). One serialized `Entry` per line — `{ id, parentId?, ts, kind, payload }`, where a summary's payload carries `sum` (the one-liner), optional `body` (full content, capped per kind), and `iid` (the writing instance's id).

- **Concurrency-safe.** Lines are short enough that POSIX `O_APPEND` writes are atomic, so multiple agent-sh instances can share one file without a lock. Only front-truncation (which rewrites the file) takes a lock — `history.jsonl.lock` via `O_EXCL`, with a 10-second stale-lock timeout to recover from crashes.
- **Ephemeral entries never touch disk.** The `recall-cache` full-body entries are appended with `{ ephemeral: true }`, a no-op on the file store — they live only in the current process.
- **Front-truncation.** After each append, the file is checked against the extension's `maxBytes` (default 50MB). Past 150% of the cap, the oldest lines are dropped and the rest rewritten atomically via temp-file + `rename`; the overshoot avoids frequent rewrites.
- **Reverse-chunked reads.** `readRecent`, `findById`, and `search` stream the file backward in 1MB chunks, stitching lines across boundaries at the byte level so UTF-8 codepoints never split. Search caps at a 20MB scan budget to bound cost on large files.

The store sits behind a generic `Store` interface (`append` / `findById` / `readRecent` / `search`), so an extension can swap in a different backend (SQLite, remote service) without changing capture or recall.

### Tier 2 — active context

The live `LiveView` array holds full messages for every turn the LLM currently sees. Alongside it, the rolling-history extension keeps two id-keyed views: the summary Store (one-liners, persisted) and the per-process `recall-cache` (full bodies, ephemeral). So once a turn is evicted from the live array, its summary stays browsable and its full text stays expandable for the rest of the session.

### Tier 3 — compaction

The kernel watches estimated prompt size against `autoCompactThreshold × (contextWindow − RESPONSE_RESERVE)` (default threshold `0.5`). When it's crossed (or `/compact` is invoked, or the API returns a context-overflow error), the kernel calls the advisable `conversation:compact` handler with a token target. The rolling-history extension's advisor implements the strategy:

1. Parse the live array into turns (a turn starts at each user message).
2. Pin the first turn and the most recent turns — the newest kept verbatim, a band just behind it "slimmed" (read-only tool calls dropped, long tool/assistant bodies trimmed).
3. Score the remaining middle turns by *priority × recency* (user messages and errors rank highest; large read-only tool results lowest) and evict lowest-first until the estimate is under target.
4. Replace the evicted span in place with one synthetic block — `[Conversation history — use conversation_recall to expand any entry]` — built from the recent summary lines, topping up summaries for any messages that missed eager capture.

On startup, if `prefetchEntries > 0` (default 50) the extension reads the most recent summary lines from the Store and injects them as a `[Prior session history]` message — so context carries across restarts the way shell history does.

### Token accounting

Compaction decisions use **API-grounded** token counts, not a chars/4 heuristic. After each API response, the provider's reported `prompt_tokens` is captured as an anchor. On the next iteration, `estimatePromptTokens()` returns that anchor plus a small local estimate for anything appended since. This keeps the trigger aligned with what the provider actually bills.

## Two mechanisms that look similar but aren't

People often conflate shell output truncation and conversation compaction. They're different things:

| | Shell output truncation | Conversation compaction |
|---|---|---|
| **Stream** | Shell context (`<shell_events>` deltas) | Conversation messages array |
| **When** | Once, at the moment each exchange is captured | On threshold crossing, `/compact`, or overflow retry |
| **State change** | Permanent: `ex.output` becomes head+tail+path | Permanent: evicted turns collapse to one-liners |
| **Full-text location** | Tempfile on disk | Ephemeral recall cache + summary store (`~/.agent-sh/rolling-history/history.jsonl`) |
| **Recovery tool** | `read_file` on the spill path | `conversation_recall` |

They fire independently. An exchange with a huge output spills as soon as it's captured; conversation compaction may not trigger until many turns later, for unrelated reasons.

## Recall APIs

Both streams offer a way to retrieve full content that isn't in live context.

### Shell output — `read_file` on the spill path

There's no dedicated shell-recall tool: the spill file is just a normal file. The agent uses `read_file`, which already supports `offset`/`limit` pagination for very large outputs.

### Conversation — `conversation_recall` tool

Registered by the built-in `rolling-history` extension (only present when that extension is active; bridges and embedded uses don't ship it):

- `conversation_recall {"action": "browse"}` — list the 25 most recent summary entries from the store
- `conversation_recall {"action": "search", "query": "..."}` — regex search across stored entries (one-line summaries plus the ephemeral full-body cache), returning each hit's header and a first-match excerpt
- `conversation_recall {"action": "expand", "turn_id": "#a1b2c3d4"}` — full content of a specific entry, by the `#id` shown in browse/search output

Extensions that install a custom compaction strategy can reuse `conversation_recall` or advise it with their own semantics.

## Extension hooks

| Handler / event | Purpose |
|---|---|
| `conversation:compact` *(advisable handler)* | Install a custom compaction strategy. Read the messages array via `conversation:get-messages`, compute a replacement, install it via `conversation:replace-messages`, return `{ before, after, evictedCount }`. |
| `conversation:message-appended` *(event)* | Fires every time a message is added (user/assistant/tool). Use it to build rolling indexes, summarize in the background, or feed external memory systems. |

Common override patterns: LLM-summarized compaction (summarize evicted turns before eviction), topic pinning (preserve turns matching pinned keywords), alternate persistence backends (SQLite, vector store, remote service).

## Slash commands

| Command | Action |
|---|---|
| `/compact` | Fire the `conversation:compact` handler (effective behavior depends on active advisors) |
| `/context` | Show context budget usage (active tokens, total tokens, budget) |
| `/history [on\|off\|status]` | Pause/resume writes to the rolling-history store for this session. Recall stays available; the tool and instruction stay registered, so toggling doesn't perturb the tools array or system prompt (LLM prompt cache is preserved). |

There's no `/clear` — history is continuous by design.

## Configuration

All settings live in `~/.agent-sh/settings.json`:

| Setting | Default | Description |
|---|---|---|
| `shellTruncateThreshold` | 20 | Output lines that trigger spill-to-tempfile at capture |
| `shellHeadLines` | 10 | Lines kept from the top when an output is spilled |
| `shellTailLines` | 10 | Lines kept from the bottom when an output is spilled |
| `autoCompactThreshold` | 0.5 | Fraction of available context window that triggers auto-compact |

The `rolling-history` extension reads its own settings, namespaced under `"rolling-history"`:

| Setting | Default | Description |
|---|---|---|
| `maxBytes` | 52428800 | Max size of the summary store before front-truncation (50MB) |
| `prefetchEntries` | 50 | Summary entries injected as `[Prior session history]` on startup (0 disables) |

## Key files

| File | Role |
|---|---|
| `src/shell/shell-context.ts` | Built-in: shell exchange capture, spill-to-tempfile on long outputs, `<shell_events>` per-query producer, `cwd` handler advisor |
| `src/utils/shell-output-spill.ts` | Per-pid session dir, cleanup on exit + signals, stale-dir sweep for crashed sessions |
| `src/agent/live-view.ts` | The live messages array the LLM sees; estimate/replace/link + API-grounded token accounting |
| `src/agent/nuclear-form.ts` | One-line-summary primitives (nucleate, serialize, priority classification) |
| `src/agent/store.ts` | `Store` interface + `SharedFileStore`: append-only JSONL with chunked search/tail-read + front-truncation |
| `src/agent/agent-loop.ts` | Auto-compact trigger, `conversation:*` handler definitions, `conversation:message-appended` emits |
| `src/agent/extensions/rolling-history/` | The built-in rolling-history extension: eager capture (`strategy.ts`), `conversation:compact` advisor, `conversation_recall` (`recall.ts`), `/history` command (`index.ts`) |
| `src/agent/index.ts` | `/compact` and `/context` slash commands registered when the ash backend starts |
