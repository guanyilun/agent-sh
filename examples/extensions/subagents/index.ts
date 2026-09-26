/**
 * Subagent extension — lets the main agent delegate to focused sub-agents.
 *
 * `spawn_agent` runs one task, or several in parallel via `tasks`. A task
 * can name an agent defined in markdown (see agents/*.md); otherwise the
 * subagent is ad hoc and the caller picks its tools.
 *
 * Agent directories, later overriding earlier by name:
 *   <this extension>/agents, ~/.agent-sh/agents, <cwd>/.agent-sh/agents
 *
 * Settings (~/.agent-sh/settings.json):
 *   { "subagents": { "maxConcurrency": 4, "maxIterations": 25 } }
 *
 * Usage:
 *   agent-sh install subagents
 *   agent-sh -e ./examples/extensions/subagents
 */
import type { AgentContext, ExtensionContext } from "agent-sh/types";
import type { ToolDefinition } from "agent-sh/agent/types";
import { runSubagent, type SubagentOptions } from "agent-sh/agent/subagent";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverAgents, type AgentDef } from "./agents.js";

const TOOL_NAME = "spawn_agent";
const PARENT_CONTEXT_CHARS = 12_000;

interface TaskSpec { agent?: string; task: string; tools?: string[] }

export default function activate(ctx: ExtensionContext & AgentContext): void {
  const { bus } = ctx;
  const settings = ctx.getExtensionSettings("subagents", { maxConcurrency: 4, maxIterations: 25 });
  const bundledDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "agents");
  const userDir = ctx.getStoragePath("agents");

  const loadAgents = () => discoverAgents([
    bundledDir,
    userDir,
    path.join(ctx.call("cwd") as string, ".agent-sh", "agents"),
  ]);

  ctx.agent.registerInstruction("subagent-guide", [
    `You have a ${TOOL_NAME} tool for delegating work to subagents with their own fresh context.`,
    "Use it for work that needs many tool calls you don't need to see: exploration, review, independent implementation.",
    "Prefer a named agent when one fits. Pass several `tasks` to run independent work in parallel.",
    "Subagents don't see this conversation unless the agent inherits context, so write a self-contained task.",
  ].join("\n"));

  ctx.agent.registerTool({
    name: TOOL_NAME,
    description:
      "Delegate a focused task to a subagent with its own fresh context. Returns the subagent's final answer. " +
      "Give `agent` + `task` for one subagent, or `tasks` to run several in parallel.",
    input_schema: {
      type: "object",
      properties: {
        agent: { type: "string", description: "Named agent to use (see list below). Omit for an ad-hoc subagent." },
        task: { type: "string", description: "What the subagent should do" },
        tools: {
          type: "array",
          items: { type: "string" },
          description: "Ad-hoc subagents only: tool names to allow (default: all)",
        },
        tasks: {
          type: "array",
          description: "Run these in parallel instead of a single task",
          items: {
            type: "object",
            properties: {
              agent: { type: "string" },
              task: { type: "string" },
              tools: { type: "array", items: { type: "string" } },
            },
            required: ["task"],
          },
        },
      },
    },

    showOutput: false,
    getDisplayInfo: () => ({ kind: "execute", icon: "⤵" }),

    formatCall: (args) => {
      const tasks = args.tasks as TaskSpec[] | undefined;
      if (tasks?.length) return `${tasks.length} parallel: ${tasks.map(t => t.agent ?? "ad-hoc").join(", ")}`;
      const task = String(args.task ?? "");
      const label = args.agent ? `${args.agent}: ${task}` : task;
      return label.length > 80 ? label.slice(0, 79) + "…" : label;
    },

    async execute(args, _onChunk, execCtx) {
      const specs: TaskSpec[] = (args.tasks as TaskSpec[] | undefined)?.length
        ? (args.tasks as TaskSpec[])
        : args.task ? [{ agent: args.agent as string | undefined, task: String(args.task), tools: args.tools as string[] | undefined }]
        : [];
      if (specs.length === 0) return error("Provide `task` or `tasks`.");

      const agents = loadAgents();
      const unknown = specs.filter(s => s.agent && !agents.has(s.agent)).map(s => s.agent);
      if (unknown.length) {
        return error(`Unknown agent: ${unknown.join(", ")}. Available: ${[...agents.keys()].join(", ") || "(none)"}`);
      }

      const signal = execCtx?.signal;
      const results = await mapLimit(specs, Math.max(1, settings.maxConcurrency), async (spec) => {
        try {
          return { ok: true, text: await runOne(spec, spec.agent ? agents.get(spec.agent) : undefined, signal) };
        } catch (err) {
          return { ok: false, text: `Subagent error: ${err instanceof Error ? err.message : String(err)}` };
        }
      });

      if (specs.length === 1) {
        const r = results[0]!;
        return { content: r.text || "(no response)", exitCode: r.ok ? 0 : 1, isError: !r.ok };
      }
      const content = results.map((r, i) => {
        const s = specs[i]!;
        return `## [${i + 1}] ${s.agent ?? "ad-hoc"}${r.ok ? "" : " (failed)"}\n\n${r.text || "(no response)"}`;
      }).join("\n\n");
      const allFailed = results.every(r => !r.ok);
      return { content, exitCode: allFailed ? 1 : 0, isError: allFailed };
    },
  });

  // Keep the advertised agent list current as the cwd (and project agents) change.
  ctx.agent.adviseToolSchema(TOOL_NAME, (next) => {
    const view = next();
    const list = [...loadAgents().values()].map(a => `- ${a.name}: ${a.description}`).join("\n");
    return list ? { ...view, description: `${view.description}\n\nNamed agents:\n${list}` } : view;
  });

  ctx.registerCommand("agents", "List named subagents", () => {
    const agents = [...loadAgents().values()];
    const message = agents.length
      ? agents.map(a => `${a.name} — ${a.description}\n    ${a.source}`).join("\n")
      : `No agents found. Add markdown agent files to ${userDir}`;
    bus.emit("ui:info", { message });
  });

  async function runOne(spec: TaskSpec, def: AgentDef | undefined, signal?: AbortSignal): Promise<string> {
    const llmClient = ctx.call("llm:get-client") as SubagentOptions["llmClient"] | undefined;
    if (!llmClient) throw new Error("no LLM client available");

    const cwd = ctx.call("cwd") as string;
    const wanted = def ? def.tools : spec.tools;
    const tools = ctx.agent.getTools()
      .filter(t => t.name !== TOOL_NAME && (!wanted || wanted.includes(t.name)))
      .map(t => throughHandlers(t, signal));

    const parentContext = def?.inheritContext ? parentTranscript() : "";
    const systemPrompt = [
      def?.systemPrompt || "You are a focused subagent. Complete the task and return a clear, concise result.",
      `Working directory: ${cwd}`,
      parentContext && `[Parent conversation, most recent last]\n${parentContext}`,
    ].filter(Boolean).join("\n\n");

    return runSubagent({
      llmClient,
      tools,
      systemPrompt,
      task: spec.task,
      model: def?.model,
      signal,
      maxIterations: def?.maxIterations ?? settings.maxIterations,
      reasoningParams: reasoningParams(def?.thinking, def?.model ?? llmClient.model),
    });
  }

  // getTools() returns raw execute fns; route through tool:<name> so adviseTool wrappers apply.
  function throughHandlers(tool: ToolDefinition, signal?: AbortSignal): ToolDefinition {
    return {
      ...tool,
      execute: (args, onChunk) => ctx.call(`tool:${tool.name}`, args, onChunk, { signal }),
    };
  }

  function reasoningParams(level: string | undefined, modelId: string): Record<string, unknown> | undefined {
    if (!level || level === "off") return undefined;
    const models = (ctx.call("agent:get-models") ?? []) as { id: string; supportsReasoningEffort?: boolean }[];
    if (!models.find(m => m.id === modelId)?.supportsReasoningEffort) return undefined;
    return { reasoning_effort: level === "xhigh" ? "high" : level };
  }

  function parentTranscript(): string {
    const { messages } = bus.emitPipe("context:snapshot", {
      messages: [], contextWindow: 0, activeTokens: 0, skipTokens: true,
    });
    const lines: string[] = [];
    for (const m of messages as { role?: string; content?: unknown }[]) {
      if (m.role !== "user" && m.role !== "assistant") continue;
      const text = messageText(m.content).trim();
      if (text) lines.push(`${m.role}: ${text}`);
    }
    const joined = lines.join("\n\n");
    return joined.length > PARENT_CONTEXT_CHARS ? "…" + joined.slice(-PARENT_CONTEXT_CHARS) : joined;
  }
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map(p => (p && typeof p === "object" && (p as any).type === "text" ? String((p as any).text ?? "") : "")).join("");
}

function error(content: string) {
  return { content, exitCode: 1, isError: true };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
