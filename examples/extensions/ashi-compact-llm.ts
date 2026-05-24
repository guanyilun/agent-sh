/**
 * Replaces ashi's default deterministic compaction summary with an
 * LLM-generated structured one. Advises `ashi:compact:build-summary`;
 * orchestration stays in ashi. Falls back to deterministic when the LLM
 * is unavailable or the call fails.
 */
import type { AgentContext } from "agent-sh/types";

interface AgentMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: unknown;
  tool_calls?: { function?: { name?: string; arguments?: string } }[];
}

const SUMMARY_PROMPT = `You are compacting a coding-agent conversation so the agent can continue with limited context.

Produce a Markdown summary using EXACTLY this structure:

## Goal
[What the user is trying to accomplish, one or two sentences]

## Constraints & Preferences
- [Bulleted user requirements / preferences expressed so far]

## Progress
### Done
- [x] [Completed work]

### In Progress
- [ ] [Active work and current sub-goal]

### Blocked
- [Issues, or "None"]

## Key Decisions
- **[Decision]**: [Rationale]

## Next Steps
1. [What should happen next]

## Critical Context
- [Specific paths, names, identifiers, or data the agent must remember]

Be concrete. Quote file paths, function names, error strings verbatim when relevant. Do not invent details that aren't in the conversation.`;

export default function activate(ctx: AgentContext): void {
  ctx.advise(
    "ashi:compact:build-summary",
    async (next: (...a: unknown[]) => unknown, evicted: AgentMessage[]) => {
      const llm = ctx.agent?.llm;
      if (!llm?.available) return next(evicted);
      try {
        const summary = await llm.ask({
          system: SUMMARY_PROMPT,
          query: buildQuery(evicted),
          maxTokens: 16384,
          reasoningEffort: "low",
        });
        return summary.trim();
      } catch (e) {
        ctx.bus.emit("ui:error", {
          message: `ashi-compact-llm: LLM failed (${(e as Error).message}); falling back to deterministic summary`,
        });
        return next(evicted);
      }
    },
  );
}

function buildQuery(messages: AgentMessage[]): string {
  const lines: string[] = ["Conversation to summarize:"];
  for (const m of messages) {
    const text = typeof m.content === "string" ? m.content : "";
    if (m.role === "user") lines.push(`[User]: ${text}`);
    else if (m.role === "assistant") {
      if (text) lines.push(`[Assistant]: ${text}`);
      if (m.tool_calls) {
        for (const t of m.tool_calls) {
          const args = t.function?.arguments ?? "";
          lines.push(`[Assistant tool call]: ${t.function?.name ?? "?"}(${truncate(args, 400)})`);
        }
      }
    } else if (m.role === "tool") {
      lines.push(`[Tool result]: ${truncate(text, 2000)}`);
    }
  }
  return lines.join("\n");
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n[…truncated ${s.length - max} chars…]`;
}
