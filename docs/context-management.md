# Context Management

agent-sh manages two separate streams of text that compete for a finite LLM context window. Understanding how they work — and how they share space — is key to getting the most out of the agent, especially with models of different context window sizes.

## The Two Streams

### Stream 1: Shell Context (situational awareness)

The **shell context** is what the user has been doing in the terminal. It's managed by `ContextManager` and injected as a `<shell_context>` block in the dynamic context on every LLM call.

It contains:
- **User shell commands** and their outputs (truncated)
- **Agent query markers** — one-liners recording what the user asked

Shell context answers the question: *"What has the user been doing?"*

### Stream 2: Conversation (task continuity)

The **conversation** is the OpenAI chat messages array — `user`, `assistant`, and `tool` messages. It's managed by `ConversationState` and appended directly to the LLM request.

It contains:
- User messages (queries)
- Assistant messages (text responses + tool calls)
- Tool results (outputs from bash, read_file, edit_file, etc.)

Conversation answers the question: *"What has the agent been working on?"*

### Why two streams?

They serve different purposes and have different lifecycles:

- Shell context is **rebuilt fresh** on every LLM call. It's a sliding window over the session.
- Conversation is **accumulated** across turns within a query session. It's the LLM's working memory.

A user might run 50 shell commands before ever asking the agent anything. That history lives in the shell context. Once the agent starts working, its tool calls and reasoning live in the conversation.

### No duplication

Agent tool outputs live **only** in the conversation stream. Shell context tracks **only** user-initiated activity (shell commands and query markers). This avoids wasting context on redundant content.

## The Token Budget

Both streams share a single budget derived from the model's actual context window.

```
Model context window (e.g. 200,000 tokens)
  - System prompt overhead        (~800 tokens)
  - Tool definitions              (~50 tokens per tool)
  - Response reserve              (8,192 tokens)
  - Dynamic context overhead      (~500 tokens for conventions, metadata)
  = Content budget
    +-- Shell context slice       (35% by default)
    +-- Conversation slice        (65% by default)
```

The split ratio is configurable via `shellContextRatio` in `~/.agent-sh/settings.json`:

```json
{ "shellContextRatio": 0.35 }
```

When the model's `contextWindow` is not configured, the budget falls back to a conservative 60,000 tokens total.

### How the budget adapts

The budget recalculates automatically when you switch models. A model with 200k context gets generous budgets for both streams. A model with 8k context gets much tighter limits, but the same ratio applies.

| Model context | Shell budget | Conversation budget |
|---------------|-------------|-------------------|
| 8,000         | ~0 tokens   | ~0 tokens (minimal overhead leaves little room) |
| 32,000        | ~6,400      | ~12,000           |
| 128,000       | ~37,000     | ~70,000           |
| 200,000       | ~62,000     | ~115,000          |

*(Numbers are approximate — actual values depend on tool count and prompt size.)*

## Shell Context Pipeline

The shell context passes through three stages before being injected into the LLM prompt:

### 1. Windowing

Keep only the last N exchanges. Default: 20. Configurable via `contextWindowSize`.

### 2. Per-exchange truncation

Long shell outputs get head+tail truncation:

```
$ find . -name "*.ts"
  ./src/index.ts
  ./src/core.ts
  ./src/settings.ts
  ./src/types.ts
  ./src/event-bus.ts
  [... 142 lines truncated, use shell_recall tool with expand and id 7 to see full output ...]
  ./examples/extensions/openrouter.ts
  ./examples/extensions/bridge.ts
  exit 0
```

Truncation thresholds are configurable:

| Setting | Default | Purpose |
|---------|---------|---------|
| `shellTruncateThreshold` | 10 lines | Lines before truncation kicks in |
| `shellHeadLines` | 5 | Lines kept from start |
| `shellTailLines` | 5 | Lines kept from end |

### 3. Budget enforcement

If the total shell context exceeds the token budget, oldest exchange outputs are stripped entirely:

```
#3 [shell cwd:/project] $ npm test
  [output omitted, use shell_recall tool to expand id 3]
```

The agent can always recover full content via `shell_recall`.

### shell_recall

Truncated content is not lost — it stays in memory. The agent can search and expand it:

- `shell_recall` — browse one-line summaries of recent exchanges
- `shell_recall --search "query"` — regex search across all session history
- `shell_recall --expand 41` — retrieve full content of exchange #41

## Conversation Compaction

When the conversation exceeds its token budget, it's **compacted** — low-priority turns are evicted to make room for new work.

### Priority-based eviction

Not all turns are equally important. Compaction evicts lowest-priority content first:

| Priority | What | Why |
|----------|------|-----|
| Pinned | First user message + last N turns | Original task + recency |
| High | User messages, error messages, assistant reasoning | Context and corrections matter |
| Medium | Tool results from write/edit operations | Produced durable changes |
| Low | Successful tool results with no errors | Can be reproduced |
| Lowest | Read-only tool results (grep, ls, read_file) | Agent can re-read these |

### Eviction archive

Evicted turns are not discarded — they're moved to an archive. The `[Earlier conversation turns evicted]` marker tells the agent that content was compacted, and it can recover it.

### conversation_recall

Mirrors `shell_recall` for conversation content:

- `conversation_recall browse` — list evicted turns with one-line summaries
- `conversation_recall --search "query"` — search evicted conversation content
- `conversation_recall --expand 5` — retrieve full content of evicted turn #5

### Auto-compaction

Compaction triggers automatically before each LLM call when the estimated token count exceeds the conversation budget. On context overflow errors from the API, a more aggressive compaction runs (60% of budget) and the request is retried.

## Message Assembly

Here's what the LLM actually sees on each call:

```
[0] system: Static identity + behavioral rules (cacheable)

[1] user: <context>
       # Available Tools
       - bash: Execute shell commands...
       - read_file: Read a file...
       ...

       # Project Conventions
       [CLAUDE.md / AGENT.md content]

       <shell_context>
       cwd: /Users/you/project
       session: 42 exchanges, 15m elapsed

       #38 [shell cwd:/project] $ git status
         On branch main
         ...
         exit 0

       #39 [you] > fix the failing test
       </shell_context>

       Current date: 2025-02-17
       Working directory: /Users/you/project
     </context>

[2] assistant: "Understood."

[3..N] Conversation messages:
       [user] fix the failing test
       [assistant] Let me look at the test... {tool_calls: [read_file]}
       [tool] {content: "test file contents..."}
       [assistant] I see the issue... {tool_calls: [edit_file]}
       [tool] {content: "File edited successfully"}
       ...
```

## Extension Hooks

Three hooks allow extensions to customize context management:

| Hook | Purpose | Called when |
|------|---------|------------|
| `context:build-extra` | Inject additional content into `<shell_context>` | Every context build |
| `dynamic-context:build` | Wrap or modify the entire dynamic context | Every LLM iteration |
| `conversation:prepare` | Transform the full message array before sending | Every LLM call |

Example: an extension could use `conversation:prepare` to implement LLM-based summarization of old turns, or `context:build-extra` to inject a terminal buffer snapshot.

## Configuration Reference

All settings in `~/.agent-sh/settings.json`:

```json
{
  "contextWindowSize": 20,
  "contextBudget": 16384,
  "shellTruncateThreshold": 10,
  "shellHeadLines": 5,
  "shellTailLines": 5,
  "shellContextRatio": 0.35,
  "recallExpandMaxLines": 100
}
```

| Setting | Default | Description |
|---------|---------|-------------|
| `contextWindowSize` | 20 | Max recent shell exchanges in context |
| `contextBudget` | 16384 | Legacy byte budget for shell context (overridden by token budget when model contextWindow is set) |
| `shellTruncateThreshold` | 10 | Shell output lines before truncation |
| `shellHeadLines` | 5 | Lines kept from start of truncated output |
| `shellTailLines` | 5 | Lines kept from end of truncated output |
| `shellContextRatio` | 0.35 | Fraction of content budget for shell context (0-1) |
| `recallExpandMaxLines` | 100 | Max lines shell_recall returns without requiring line ranges |

## Key Files

| File | Role |
|------|------|
| `src/context-manager.ts` | Shell exchange storage, windowing, truncation, recall API |
| `src/agent/conversation-state.ts` | Conversation messages, priority compaction, eviction archive |
| `src/token-budget.ts` | Unified budget calculator (splits context window between streams) |
| `src/agent/agent-loop.ts` | Wires budget into compaction + context assembly |
| `src/agent/system-prompt.ts` | Builds dynamic context, passes shell budget |
| `src/extensions/shell-recall.ts` | Terminal interception for `__shell_recall` commands |
