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

Captured and owned by `ContextManager`. Tracks only user-initiated activity:

- Shell commands the user ran + their outputs
- Markers for user queries to the agent (so agent queries interleave chronologically with shell commands)

Agent tool outputs are **not** here — those live in the conversation stream. The boundary is strict: if the user typed it at the PTY, it goes into shell context; if the agent called a tool, it goes into the conversation.

### Conversation — "what has the agent been working on?"

Owned by `ConversationState`. This is the OpenAI-shaped messages array (`user` / `assistant` / `tool`) the LLM actually sees. Contains:

- User messages (queries the user sent to the agent)
- Assistant messages (the LLM's replies)
- Tool calls and tool results

The two streams merge at one point: when the user submits a new query, new shell events are prepended to that user message as a `<shell-events>` delta. They then live inside the conversation array as regular bytes, but they are never stored separately in both places.

## How shell activity reaches the LLM

Each exchange (a shell command + output, or an agent-query marker) gets a sequential `id` as it's captured. The agent keeps a `lastShellSeq` cursor — the highest id it has already sent to the model. On each new user query:

1. `getEventsSince(lastShellSeq)` returns every exchange with a higher id.
2. The delta is formatted as `<shell-events>...</shell-events>` and prepended to the user's query inside a single user message.
3. `lastShellSeq` advances to the new high-water mark.

The delta is sent **once per user query**, not per tool-use step inside the agent loop. Inside the loop (where the LLM calls tools, sees results, calls more tools), no new shell events are injected — injecting mid-loop would break the `tool_call → tool_result` chain some providers require.

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

Unlike shell context — which is a per-query delta and stays small — the conversation grows every turn. Without an active strategy it would eventually blow past the model's window. agent-sh uses a three-tier scheme designed to feel like shell history.

### Tier 1 — eager nucleation

As soon as any message is added to the conversation, it's *nucleated*: a one-line summary is computed immediately and appended to `~/.agent-sh/history` (JSONL, append-only, concurrency-safe across multiple running instances).

- Read-only tool results are skipped for disk writes — the agent can re-run the tool if it needs them again.
- The file is front-truncated when it exceeds `historyMaxBytes` (default 100MB).

### Tier 2 — active context

The in-memory conversation holds three things at once:

- Full messages for each live turn (verbatim)
- A rolling in-context "nuclear block" (the one-liners) that gives the agent high-level orientation
- An in-memory recall archive keyed by sequence id, so evicted content stays searchable within the session

### Tier 3 — compaction

The kernel watches estimated prompt size against `autoCompactThreshold × (contextWindow − responseReserve)`. When that threshold is crossed (or `/compact` is invoked explicitly, or the API returns a context-overflow error), it fires the `conversation:compact` handler.

Built-in strategy:

1. Keep the first turn verbatim (earliest user intent usually matters)
2. Keep the last `keepRecent` turns verbatim (the live focus)
3. Score the remaining middle turns by *priority × recency* and evict lowest-priority first
4. Evicted turns collapse in place to their one-line nuclear summaries

On startup, the most recent `historyStartupEntries` entries from `~/.agent-sh/history` are injected as a `[Prior session history]` preamble — so context carries across restarts the way shell history does.

### Token accounting

Compaction decisions use **API-grounded** token counts, not a chars/4 heuristic. After each API response, the provider's reported `prompt_tokens` is captured as an anchor. On the next iteration, `estimatePromptTokens()` returns that anchor plus a small local estimate for anything appended since. This keeps the trigger aligned with what the provider actually bills.

## Two mechanisms that look similar but aren't

People often conflate shell output truncation and conversation compaction. They're different things:

| | Shell output truncation | Conversation compaction |
|---|---|---|
| **Stream** | Shell context (`<shell-events>` deltas) | Conversation messages array |
| **When** | Once, at the moment each exchange is captured | On threshold crossing, `/compact`, or overflow retry |
| **State change** | Permanent: `ex.output` becomes head+tail+path | Permanent: evicted turns collapse to one-liners |
| **Full-text location** | Tempfile on disk | In-memory archive + `~/.agent-sh/history` |
| **Recovery tool** | `read_file` on the spill path | `conversation_recall` |

They fire independently. An exchange with a huge output spills as soon as it's captured; conversation compaction may not trigger until many turns later, for unrelated reasons.

## Recall APIs

Both streams offer a way to retrieve full content that isn't in live context.

### Shell output — `read_file` on the spill path

There's no dedicated shell-recall tool: the spill file is just a normal file. The agent uses `read_file`, which already supports `offset`/`limit` pagination for very large outputs.

### Conversation — `conversation_recall` tool

Registered by the built-in agent:

- `conversation_recall {"action": "browse"}` — list in-context nuclear entries + recent history-file entries
- `conversation_recall {"action": "search", "query": "..."}` — regex search across the in-session archive and the history file (both one-line summaries and full bodies)
- `conversation_recall {"action": "expand", "turn_id": 42}` — full content of a specific turn

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

There's no `/clear` — history is continuous by design.

## Configuration

All settings live in `~/.agent-sh/settings.json`:

| Setting | Default | Description |
|---|---|---|
| `shellTruncateThreshold` | 20 | Output lines that trigger spill-to-tempfile at capture |
| `shellHeadLines` | 10 | Lines kept from the top when an output is spilled |
| `shellTailLines` | 10 | Lines kept from the bottom when an output is spilled |
| `autoCompactThreshold` | 0.5 | Fraction of available context window that triggers auto-compact |
| `historyMaxBytes` | 104857600 | Max size of `~/.agent-sh/history` before front-truncation (100MB) |
| `historyStartupEntries` | 100 | Prior history entries injected as `[Prior session history]` on startup |

## Key files

| File | Role |
|---|---|
| `src/context-manager.ts` | Shell exchange capture, spill-to-tempfile on long outputs, delta emission via `getEventsSince` |
| `src/utils/shell-output-spill.ts` | Per-pid session dir, cleanup on exit + signals, stale-dir sweep for crashed sessions |
| `src/agent/conversation-state.ts` | Messages array, eager nucleation, priority-based compaction, in-memory recall archive |
| `src/agent/nuclear-form.ts` | One-line-summary primitives (nucleate, serialize, priority classification) |
| `src/agent/history-file.ts` | Append-only `~/.agent-sh/history` with chunked search/tail-read + front-truncation |
| `src/agent/agent-loop.ts` | Auto-compact trigger, `conversation:compact` advisor chain, registers the `conversation_recall` tool |
| `src/extensions/slash-commands.ts` | `/compact` and `/context` implementations |
