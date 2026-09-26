/** Named and parallel subagents via spawn_agent, and scripted workflows via run_workflow; see README.md. */
import type { AgentContext, ExtensionContext } from "agent-sh/types";
import type { ToolDefinition } from "agent-sh/agent/types";
import { runSubagent, type SubagentOptions, type SubagentRunMeta } from "agent-sh/agent/subagent";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverAgents, type AgentDef } from "./agents.js";
import { discoverWorkflows, formatResult, runWorkflow, TrustStore, type WorkflowDef } from "./workflows.js";
import type { RunSpec } from "./workflow-types.js";

export type { Workflow, WorkflowApi, RunSpec, JsonSchema } from "./workflow-types.js";

const TOOL_NAME = "spawn_agent";
const WORKFLOW_TOOL = "run_workflow";
const CHILD_EXCLUDED = new Set([TOOL_NAME, WORKFLOW_TOOL]);
const PARENT_CONTEXT_CHARS = 12_000;

interface TaskSpec { agent?: string; task: string; tools?: string[] }

export default function activate(ctx: ExtensionContext & AgentContext): void {
  const { bus } = ctx;
  const settings = ctx.getExtensionSettings("subagents", { maxConcurrency: 4, maxIterations: 25, maxRunsPerWorkflow: 50 });
  const extDir = path.dirname(fileURLToPath(import.meta.url));
  const bundledDir = path.join(extDir, "agents");
  const userDir = ctx.getStoragePath("agents");
  const userWorkflowDir = ctx.getStoragePath("workflows");
  const trust = new TrustStore(path.join(ctx.getStoragePath("subagents"), "trusted-workflows.json"));

  const loadAgents = () => discoverAgents([
    bundledDir,
    userDir,
    path.join(ctx.call("cwd") as string, ".agent-sh", "agents"),
  ]);

  const loadWorkflows = () => {
    const projectDir = path.join(ctx.call("cwd") as string, ".agent-sh", "workflows");
    return discoverWorkflows([
      { dir: path.join(extDir, "workflows"), scope: "bundled" },
      { dir: userWorkflowDir, scope: "user" },
      // From $HOME the project dir is the user dir; don't demote the user's own workflows to untrusted.
      ...(samePath(projectDir, userWorkflowDir) ? [] : [{ dir: projectDir, scope: "project" as const }]),
    ]);
  };
  const untrustedHint = (wf: WorkflowDef) =>
    `Workflow "${wf.name}" is a project file (${wf.file}) that hasn't been trusted in its current form. ` +
    `Ask the user to review it and run /workflow trust ${wf.name}.`;

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

    getDisplayInfo: () => ({ kind: "execute", icon: "⤵" }),

    formatCall: (args) => {
      const tasks = args.tasks as TaskSpec[] | undefined;
      if (tasks?.length) return `${tasks.length} parallel: ${tasks.map(t => t.agent ?? "ad-hoc").join(", ")}`;
      const task = String(args.task ?? "");
      const label = args.agent ? `${args.agent}: ${task}` : task;
      return label.length > 80 ? label.slice(0, 79) + "…" : label;
    },

    async execute(args, onChunk, execCtx) {
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
      const results = await mapLimit(specs, Math.max(1, settings.maxConcurrency), async (spec, i) => {
        const name = spec.agent ?? "ad-hoc";
        const label = specs.length > 1 ? `[${i + 1} ${name}]` : `[${name}]`;
        const progress = onChunk ? (line: string) => onChunk(`${label} ${line}\n`) : undefined;
        try {
          return { ok: true, text: await runOne(spec, spec.agent ? agents.get(spec.agent) : undefined, signal, progress) };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          progress?.(`failed: ${message}`);
          return { ok: false, text: `Subagent error: ${message}` };
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

  // Re-read per request so project agents follow the cwd.
  ctx.agent.adviseToolSchema(TOOL_NAME, (next) => {
    const view = next();
    const list = [...loadAgents().values()].map(a => `- ${a.name}: ${a.description}`).join("\n");
    return list ? { ...view, description: `${view.description}\n\nNamed agents:\n${list}` } : view;
  });

  ctx.agent.registerTool({
    name: WORKFLOW_TOOL,
    description:
      "Run a saved workflow: a script that coordinates subagents (sequences, parallel steps, loops) and returns its result. " +
      "Pass `args` as the workflow expects them (free text).",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Workflow name (see list below)" },
        args: { type: "string", description: "Arguments for the workflow" },
      },
      required: ["name"],
    },
    getDisplayInfo: () => ({ kind: "execute", icon: "⤵" }),
    formatCall: (args) => [args.name, args.args].filter(Boolean).join(" "),

    async execute(args, onChunk, execCtx) {
      const workflows = loadWorkflows();
      const wf = workflows.get(String(args.name ?? ""));
      if (!wf) return error(`Unknown workflow: ${args.name}. Available: ${[...workflows.keys()].join(", ") || "(none)"}`);
      if (!trust.isTrusted(wf)) return error(untrustedHint(wf));

      const signal = execCtx?.signal ?? new AbortController().signal;
      const progress = (line: string) => onChunk?.(`${line}\n`);
      try {
        const result = await runWorkflow(wf, String(args.args ?? ""), {
          runTask,
          complete: (messages) => ctx.call("llm:invoke", messages, { maxTokens: 4096 }) as Promise<string>,
          maxConcurrency: settings.maxConcurrency,
          maxRuns: settings.maxRunsPerWorkflow,
        }, signal, progress);
        return { content: formatResult(result), exitCode: 0, isError: false };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        progress(`failed: ${message}`);
        return error(`Workflow "${wf.name}" failed: ${message}`);
      }
    },
  });

  ctx.agent.adviseToolSchema(WORKFLOW_TOOL, (next) => {
    const view = next();
    const list = [...loadWorkflows().values()]
      .map(w => `- ${w.name}: ${w.description || "(no description)"}${trust.isTrusted(w) ? "" : " [untrusted: the user must run /workflow trust " + w.name + "]"}`)
      .join("\n");
    return { ...view, description: `${view.description}\n\nWorkflows:\n${list || "(none yet)"}` };
  });

  ctx.agent.registerSkill(
    "writing-workflows",
    "How to write an agent-sh workflow script (run/all/schema/loops) and where to save it",
    path.join(extDir, "WORKFLOWS.md"),
  );

  ctx.registerCommand("workflow", "List, trust, or run workflows: /workflow [trust] <name> [args]", (input) => {
    const [first = "", ...rest] = input.trim().split(/\s+/).filter(Boolean);
    const workflows = loadWorkflows();

    if (!first) {
      const message = workflows.size
        ? [...workflows.values()].map(w =>
            `${w.name} — ${w.description || "(no description)"}${trust.isTrusted(w) ? "" : "  [untrusted]"}\n    ${w.file}`).join("\n")
        : `No workflows found. Add one to ${userWorkflowDir} or <project>/.agent-sh/workflows/`;
      bus.emit("ui:info", { message });
      return;
    }

    if (first === "trust") {
      const wf = workflows.get(rest[0] ?? "");
      if (!wf) { bus.emit("ui:error", { message: `Unknown workflow: ${rest[0] ?? "(none given)"}` }); return; }
      trust.trust(wf);
      bus.emit("ui:info", { message: `Trusted ${wf.file} as it is now. Editing it will require trusting it again.` });
      return;
    }

    const wf = workflows.get(first);
    if (!wf) { bus.emit("ui:error", { message: `Unknown workflow: ${first}. Run /workflow to list them.` }); return; }
    if (!trust.isTrusted(wf)) {
      bus.emit("ui:error", { message: `${wf.file} is an untrusted project workflow. Review it, then run /workflow trust ${wf.name}.` });
      return;
    }
    const wfArgs = input.trim().slice(first.length).trim();
    bus.emit("agent:submit", {
      query: `Run the "${wf.name}" workflow with ${WORKFLOW_TOOL}${wfArgs ? ` and args ${JSON.stringify(wfArgs)}` : ""}, then report its result.`,
    });
  });

  ctx.registerCommand("agents", "List named subagents", () => {
    const agents = [...loadAgents().values()];
    const message = agents.length
      ? agents.map(a => `${a.name} — ${a.description}\n    ${a.source}`).join("\n")
      : `No agents found. Add markdown agent files to ${userDir}`;
    bus.emit("ui:info", { message });
  });

  function runTask(spec: RunSpec, signal: AbortSignal, progress: (line: string) => void): Promise<string> {
    const def = spec.agent ? loadAgents().get(spec.agent) : undefined;
    if (spec.agent && !def) throw new Error(`unknown agent: ${spec.agent}`);
    return runOne(spec, def, signal, progress);
  }

  async function runOne(
    spec: TaskSpec,
    def: AgentDef | undefined,
    signal?: AbortSignal,
    progress?: (line: string) => void,
  ): Promise<string> {
    const llmClient = ctx.call("llm:get-client") as SubagentOptions["llmClient"] | undefined;
    if (!llmClient) throw new Error("no LLM client available");

    const cwd = ctx.call("cwd") as string;
    const wanted = def ? def.tools : spec.tools;
    const tools = ctx.agent.getTools()
      .filter(t => !CHILD_EXCLUDED.has(t.name) && (!wanted || wanted.includes(t.name)))
      .map(t => throughHandlers(t, cwd, signal, progress));

    const parentContext = def?.inheritContext ? parentTranscript() : "";
    const systemPrompt = [
      def?.systemPrompt || "You are a focused subagent. Complete the task and return a clear, concise result.",
      `Working directory: ${cwd}`,
      parentContext && `[Parent conversation, most recent last]\n${parentContext}`,
    ].filter(Boolean).join("\n\n");

    const meta: SubagentRunMeta = {};
    const text = await runSubagent({
      llmClient,
      tools,
      systemPrompt,
      task: spec.task,
      model: def?.model,
      signal,
      maxIterations: def?.maxIterations ?? settings.maxIterations,
      reasoningParams: reasoningParams(def?.thinking, def?.model ?? llmClient.model),
      outMeta: meta,
    });
    progress?.(signal?.aborted ? "cancelled"
      : meta.degraded === "iterations" ? "stopped: step limit reached"
      : meta.degraded === "budget" ? "stopped: token budget reached"
      : "done");
    return text;
  }

  // getTools() returns raw execute fns; go through tool:<name> so adviseTool wrappers apply.
  function throughHandlers(tool: ToolDefinition, cwd: string, signal?: AbortSignal, progress?: (line: string) => void): ToolDefinition {
    return {
      ...tool,
      execute: (args, onChunk) => {
        const detail = describeCall(tool, args, cwd);
        progress?.(detail ? `${tool.name}: ${detail}` : tool.name);
        return ctx.call(`tool:${tool.name}`, args, onChunk, { signal });
      },
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

function samePath(a: string, b: string): boolean {
  const real = (p: string) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  return real(a) === real(b);
}

function describeCall(tool: ToolDefinition, args: Record<string, unknown>, cwd: string): string {
  let detail = "";
  try { detail = tool.formatCall?.(args) ?? ""; } catch {}
  if (!detail) {
    const v = args.command ?? args.path ?? args.pattern ?? args.query;
    if (typeof v === "string") detail = v;
  }
  detail = detail.split(cwd + path.sep).join("").split(cwd).join(".").replace(/\s+/g, " ").trim();
  return detail.length > 100 ? detail.slice(0, 99) + "…" : detail;
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map(p => (p && typeof p === "object" && (p as any).type === "text" ? String((p as any).text ?? "") : "")).join("");
}

function error(content: string) {
  return { content, exitCode: 1, isError: true };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
