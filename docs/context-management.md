# Context Management

## Design Philosophy

Most coding agents treat context as a session problem — you start a chat, work on something, and eventually the context fills up or you start a new session. This works when the agent owns the entire interaction, but agent-sh is different: **we live in a terminal.**

The terminal is continuous. You run commands, switch between tasks, help a colleague, come back to what you were doing. Nobody thinks about "sessions" when using a shell. Shell history is just *there* — always available, always growing, persisting across restarts. You never manage it, but you can always search it.

This is the model agent-sh follows for context management:

**No sessions.** There's no "new session" or "clear." History is continuous and append-only, like `.zsh_history`.

**No assumptions about workflow.** We don't try to detect topic changes, time gaps, or "the user has moved on." If someone asks about React after a database discussion, maybe they're helping a colleague for 30 seconds. Any heuristic that guesses intent will be wrong often enough to be annoying. The only reason to evict content is mechanical: the context window is full and we need space.

**Two streams, no duplication.** The user's shell activity and the agent's work are fundamentally different kinds of information. Shell context provides situational awareness ("what has the user been doing?"). Conversation provides task continuity ("what has the agent been working on?"). They share a budget but never duplicate content.

**Model-aware.** A 200k context model should behave differently from an 8k model. The token budget adapts to the model's actual context window, not a hardcoded threshold.

**Strategy is pluggable.** The kernel decides *when* to compact (threshold crossing, explicit `/compact`, overflow retry). *How* to compact — what to preserve, how to summarise, whether to archive evicted turns elsewhere — is an extension responsibility, plugged in via the advisable `conversation:compact` handler. If no extension provides a strategy, compaction is a no-op and conversations overflow naturally instead of being silently truncated.

## The Two Streams

### Shell Context (situational awareness)

Managed by `ContextManager`, injected as `<shell_context>` on every LLM call.

Contains only user-initiated activity:
- User shell commands and outputs (truncated)
- Agent query markers

### Conversation (task continuity)

Managed by `ConversationState`, appended to the LLM messages array.

Contains agent work:
- User messages, assistant messages, tool calls, tool results

No duplication — agent tool outputs live only in the conversation stream.

## Token Budget

Shell context is sized using a rough budget derived from the model's context window:

```
Model context window (e.g. 200,000 tokens)
  - System prompt + tool defs + response reserve (estimated overhead)
  = Content budget
    +-- Shell context (35% by default, via shellContextRatio)
```

Configurable via `shellContextRatio` in settings. Recalculates on model switch. Falls back to 60k tokens when `contextWindow` is not set.

**Compaction checks use API-grounded token counts.** The auto-compact threshold is based on real `prompt_tokens` from the LLM API response, not the chars/4 heuristic. After each API call, the reported `prompt_tokens` (total input including system prompt, tools, context, and conversation) is captured. On the next iteration, `estimatePromptTokens()` returns the last API value plus a rough estimate for any messages added since.

## Compaction Hook

When the kernel detects that compaction is warranted, it invokes the `conversation:compact` handler. This handler is advisable — extensions wrap it to implement their own strategy.

**Default (no extension advising):** pass-through no-op. Messages stay as-is; the next LLM call may overflow.

**With a strategy extension:** the advisor receives the full messages array plus metadata about why compaction was triggered, and returns a replacement array. Typical strategies:
- Evict old tool results while keeping user messages
- Summarise evicted turns into one-liners injected back into context
- Archive evicted turns to disk for a recall tool
- Pin specific topics/turns that must survive

Observation hook: `conversation:message-appended` fires every time a message is added to the conversation (user/assistant/tool), allowing extensions to build rolling indexes, summarise content, or feed memory systems.

## Shell Context Pipeline

Shell context passes through three stages:

1. **Windowing** — last N exchanges (default 20, configurable via `contextWindowSize`)
2. **Per-exchange truncation** — long outputs get head+tail (configurable thresholds)
3. **Budget enforcement** — oldest outputs stripped if over token budget

The agent can recover full content via `shell_recall`.

## Recall Tools

### shell_recall

Recovers truncated shell context:
- `shell_recall` — browse recent exchanges
- `shell_recall --search "query"` — regex search
- `shell_recall --expand 41` — full content of exchange #41

Conversation recall, if provided, is a tool registered by whichever extension owns conversation compaction strategy.

## Slash Commands

| Command | Action |
|---------|--------|
| `/compact` | Fire the `conversation:compact` handler (effective behavior depends on active advisors) |
| `/context` | Show context budget usage (active tokens, total tokens, budget) |

History is continuous — there's no `/clear`.

## Configuration

All settings in `~/.agent-sh/settings.json`:

| Setting | Default | Description |
|---------|---------|-------------|
| `contextWindowSize` | 20 | Max recent shell exchanges in context |
| `contextBudget` | 32768 | Byte budget for shell context |
| `shellTruncateThreshold` | 20 | Shell output lines before truncation |
| `shellHeadLines` | 10 | Lines kept from start of truncated output |
| `shellTailLines` | 10 | Lines kept from end |
| `shellContextRatio` | 0.35 | Fraction of content budget for shell context |
| `recallExpandMaxLines` | 500 | Max lines shell_recall expand returns without line ranges |
| `autoCompactThreshold` | 0.5 | Fraction of context window at which auto-compact triggers |

## Key Files

| File | Role |
|------|------|
| `src/context-manager.ts` | Shell exchange storage, windowing, truncation, recall API |
| `src/agent/conversation-state.ts` | Messages array + token estimation (API-grounded + chars/4 fallback) |
| `src/agent/token-budget.ts` | Shell context budget calculator. Exports `RESPONSE_RESERVE`, `DEFAULT_CONTEXT_WINDOW` |
| `src/agent/agent-loop.ts` | Wires budget, API token feedback, auto-compact trigger, invokes `conversation:compact` advisor chain |
| `src/extensions/slash-commands.ts` | /compact, /context commands |
