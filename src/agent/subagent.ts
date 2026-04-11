/**
 * Subagent runner — executes a focused agent loop with its own context.
 *
 * Unlike the main AgentLoop, a subagent:
 *   - Has its own conversation (starts fresh, stays focused)
 *   - Has its own system prompt (specialized for the task)
 *   - Runs to completion and returns the final text
 *   - Optionally emits tool events to the bus for TUI rendering
 *
 * Used by the subagent extension to delegate tasks from the main agent.
 */
import type { EventBus } from "../event-bus.js";
import type { LlmClient } from "../utils/llm-client.js";
import type { ToolDefinition } from "./types.js";
import { ConversationState } from "./conversation-state.js";

interface PendingToolCall {
  id: string;
  name: string;
  argumentsJson: string;
}

export interface SubagentOptions {
  /** LLM client to use. */
  llmClient: LlmClient;
  /** Tools available to the subagent. */
  tools: ToolDefinition[];
  /** System prompt for this subagent. */
  systemPrompt: string;
  /** The task to perform. */
  task: string;
  /** Model override (optional, defaults to llmClient's model). */
  model?: string;
  /** Event bus for TUI events (optional — silent if omitted). */
  bus?: EventBus;
  /** Abort signal for cancellation. */
  signal?: AbortSignal;
  /** Max tool loop iterations (default 20). */
  maxIterations?: number;
}

/**
 * Run a subagent to completion.
 * Returns the final response text.
 */
export async function runSubagent(opts: SubagentOptions): Promise<string> {
  const {
    llmClient,
    tools,
    systemPrompt,
    task,
    model,
    bus,
    signal,
    maxIterations = 20,
  } = opts;

  const toolMap = new Map(tools.map(t => [t.name, t]));
  const apiTools = tools.map(t => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }));

  const conversation = new ConversationState();
  conversation.addUserMessage(task);

  let fullResponseText = "";
  let iterations = 0;

  while (iterations++ < maxIterations) {
    if (signal?.aborted) break;

    // Stream LLM response
    const { text, toolCalls, assistantContent, assistantToolCalls } =
      await streamOnce(llmClient, systemPrompt, conversation, apiTools, model, signal);

    fullResponseText += text;

    conversation.addAssistantMessage(assistantContent, assistantToolCalls);

    // No tool calls → done
    if (toolCalls.length === 0) break;

    // Execute tools
    for (const tc of toolCalls) {
      if (signal?.aborted) break;

      const tool = toolMap.get(tc.name);
      if (!tool) {
        conversation.addToolResult(tc.id, `Error: Unknown tool "${tc.name}"`);
        continue;
      }

      let args: Record<string, unknown>;
      try {
        args = JSON.parse(tc.argumentsJson);
      } catch {
        conversation.addToolResult(tc.id, `Error: Invalid JSON arguments for ${tc.name}`);
        continue;
      }

      // Emit tool events for TUI (if bus provided)
      if (bus) {
        const display = tool.getDisplayInfo?.(args) ?? { kind: "execute" };
        bus.emit("agent:tool-started", {
          title: tc.name,
          toolCallId: tc.id,
          kind: display.kind,
          locations: display.locations,
          rawInput: args,
        });
      }

      const onChunk = bus && tool.showOutput !== false
        ? (chunk: string) => { bus.emit("agent:tool-output-chunk", { chunk }); }
        : undefined;

      const result = await tool.execute(args, onChunk);

      if (bus) {
        const display = tool.getDisplayInfo?.(args) ?? { kind: "execute" };
        bus.emit("agent:tool-completed", {
          toolCallId: tc.id,
          exitCode: result.exitCode,
          rawOutput: result.content,
          kind: display.kind,
        });
      }

      const content = result.isError ? `Error: ${result.content}` : result.content;
      conversation.addToolResult(tc.id, content);
    }
  }

  return fullResponseText;
}

/** Stream a single LLM response. */
async function streamOnce(
  llmClient: LlmClient,
  systemPrompt: string,
  conversation: ConversationState,
  apiTools: any[],
  model: string | undefined,
  signal: AbortSignal | undefined,
): Promise<{
  text: string;
  toolCalls: PendingToolCall[];
  assistantContent: string | null;
  assistantToolCalls: { id: string; function: { name: string; arguments: string } }[] | undefined;
}> {
  let text = "";
  const pendingToolCalls: PendingToolCall[] = [];

  const stream = await llmClient.stream({
    messages: [
      { role: "system", content: systemPrompt },
      ...conversation.getMessages(),
    ],
    tools: apiTools.length > 0 ? apiTools : undefined,
    model,
    signal,
  });

  for await (const chunk of stream) {
    if (signal?.aborted) break;

    const choice = chunk.choices[0];
    if (!choice) continue;
    const delta = choice.delta;

    if (delta?.content) {
      text += delta.content;
    }

    if (delta?.tool_calls) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index;
        if (!pendingToolCalls[idx]) {
          pendingToolCalls[idx] = { id: tc.id!, name: tc.function!.name!, argumentsJson: "" };
        }
        if (tc.function?.arguments) {
          pendingToolCalls[idx].argumentsJson += tc.function.arguments;
        }
      }
    }
  }

  const assistantToolCalls = pendingToolCalls.length
    ? pendingToolCalls.map(tc => ({ id: tc.id, function: { name: tc.name, arguments: tc.argumentsJson } }))
    : undefined;

  return { text, toolCalls: pendingToolCalls, assistantContent: text || null, assistantToolCalls };
}
