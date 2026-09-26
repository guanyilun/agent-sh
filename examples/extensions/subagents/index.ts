/** Named, parallel and background subagents (spawn_agent), scripted workflows (run_workflow); see README.md. */
import type { AgentContext, ExtensionContext } from "agent-sh/types";
import type { ToolDefinition } from "agent-sh/agent/types";
import { runSubagent, type SubagentOptions, type SubagentRunMeta } from "agent-sh/agent/subagent";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverAgents, type AgentDef } from "./agents.js";
import { describe, JobTable, type JobOutcome } from "./jobs.js";
import { Semaphore } from "./semaphore.js";
import { RunStore } from "./runs.js";
import { normalizeSchema, validate } from "./schema.js";
import {
  discoverWorkflows, formatResult, runWorkflow, TrustStore,
  type TaskControl, type TaskResult, type WorkflowDef,
} from "./workflows.js";
import type { RunSpec } from "./workflow-types.js";

export type { Workflow, WorkflowApi, RunSpec, JsonSchema } from "./workflow-types.js";

const TOOL_NAME = "spawn_agent";
const WORKFLOW_TOOL = "run_workflow";
const JOBS_TOOL = "subagent_jobs";
const SUBMIT_TOOL = "submit_result";
const CHILD_EXCLUDED = new Set([TOOL_NAME, WORKFLOW_TOOL, JOBS_TOOL]);
const BACKGROUND_PARAM = {
  type: "boolean",
  description: `Return at once and run in the background. Its status shows in your context each turn; read the result with ${JOBS_TOOL}.`,
};
const PARENT_CONTEXT_CHARS = 12_000;

interface TaskSpec { agent?: string; task: string; tools?: string[] }

interface RunExtras {
  extraTools?: ToolDefinition[];
  systemNote?: string;
  shouldStop?: () => boolean;
  onUsage?: (totalTokens: number) => void;
  onMessage?: (message: Record<string, unknown>) => void;
}

export default function activate(ctx: ExtensionContext & AgentContext): void {
  const { bus } = ctx;
  const settings = ctx.getExtensionSettings("subagents", {
    maxConcurrency: 4, maxIterations: 25, maxRunsPerWorkflow: 50, backgroundWake: true, workflowTokenBudget: 0,
  });
  const extDir = path.dirname(fileURLToPath(import.meta.url));
  const bundledDir = path.join(extDir, "agents");
  const userDir = ctx.getStoragePath("agents");
  const userWorkflowDir = ctx.getStoragePath("workflows");
  const trust = new TrustStore(path.join(ctx.getStoragePath("subagents"), "trusted-workflows.json"));
  const runs = new RunStore(ctx.getStoragePath("workflow-runs"));
  // Shared by foreground and background runs so background work can't flood the provider.
  const slots = new Semaphore(Math.max(1, settings.maxConcurrency));

  // Status goes in dynamic context, results come back as tool results, and a
  // short note wakes the agent only when it's idle with unread results.
  const jobs = new JobTable((job) => {
    if (!settings.backgroundWake) {
      bus.emit("ui:info", { message: `Background run #${job.id} (${job.label}) ${job.status}; the agent sees it on your next message.` });
    }
    scheduleWake();
    bus.emit("agent:pending-work-changed", {});
  });
  const needsWake = () => jobs.unread().filter(j => !j.announced);
  let agentBusy = false;
  bus.on("agent:processing-start", () => { agentBusy = true; });
  bus.on("agent:processing-done", () => { agentBusy = false; scheduleWake(); });
  // Batch runs that finish close together into one note.
  const scheduleWake = () => { setTimeout(wake, 100); };
  function wake(): void {
    if (agentBusy || !settings.backgroundWake) return;
    const fresh = needsWake();
    if (!fresh.length) return;
    for (const j of fresh) j.announced = true;
    const list = fresh.map(j => `#${j.id} ${j.label} (${j.status})`).join(", ");
    bus.emit("agent:steer", { text: `[background] Finished: ${list}. Read the result${fresh.length > 1 ? "s" : ""} with ${JOBS_TOOL}.` });
    bus.emit("agent:pending-work-changed", {});
  }
  bus.onPipe("agent:pending-work", (p) => ({
    count: p.count + jobs.running().length + (settings.backgroundWake ? needsWake().length : 0),
  }));
  bus.on("agent:reset-session", () => jobs.clear());
  ctx.onDispose(() => jobs.clear());

  ctx.agent.registerContextProducer("background-subagents", () => {
    const shown = jobs.list().filter(j => j.status === "running" || !j.read);
    if (!shown.length) return null;
    return [
      "Background subagent runs:",
      ...shown.map(j => `- ${describe(j)}`),
      `Read finished runs with ${JOBS_TOOL}; don't redo work a running one covers.`,
    ].join("\n");
  });

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
    `Set \`background: true\` on ${TOOL_NAME} or ${WORKFLOW_TOOL} to keep working while it runs; its status shows in your context and you read the result with ${JOBS_TOOL}.`,
    "Don't run a writing agent in the background on files you are editing yourself.",
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
        background: BACKGROUND_PARAM,
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

      const work = (signal?: AbortSignal, progress?: (line: string) => void) => runSpecs(specs, agents, signal, progress);
      if (args.background) {
        const label = specs.length > 1 ? `${specs.length} parallel: ${specs.map(s => s.agent ?? "ad-hoc").join(", ")}` : specs[0]!.agent ?? "ad-hoc";
        return startBackground(label, work);
      }
      return toolResult(await work(execCtx?.signal, onChunk ? (line) => onChunk(`${line}\n`) : undefined));
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
      "Pass `args` as the workflow expects them (free text). Every run is logged with an id; `resume` an interrupted " +
      "or failed run by id to reuse the subagent results it already has.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Workflow name (see list below); optional with `resume`" },
        args: { type: "string", description: "Arguments for the workflow; with `resume`, defaults to the earlier run's" },
        resume: { type: "string", description: "Id of an earlier run of this workflow to resume" },
        budgetTokens: { type: "number", description: "Cap on subagent tokens for this run (default: subagents.workflowTokenBudget)" },
        background: BACKGROUND_PARAM,
      },
    },
    getDisplayInfo: () => ({ kind: "execute", icon: "⤵" }),
    formatCall: (args) => args.resume ? `resume ${args.resume}` : [args.name, args.args].filter(Boolean).join(" "),

    async execute(args, onChunk, execCtx) {
      const resumeId = args.resume === undefined ? undefined : String(args.resume);
      const previous = resumeId ? runs.get(resumeId) : undefined;
      if (resumeId && !previous) return error(`No workflow run ${resumeId}. Recent runs: /workflow runs`);
      const name = String(args.name ?? previous?.workflow ?? "");
      if (previous && previous.workflow !== name) return error(`Run ${resumeId} is of workflow "${previous.workflow}", not "${name}".`);

      const workflows = loadWorkflows();
      const wf = workflows.get(name);
      if (!wf) return error(`Unknown workflow: ${name || "(none given)"}. Available: ${[...workflows.keys()].join(", ") || "(none)"}`);
      if (!trust.isTrusted(wf)) return error(untrustedHint(wf));

      const wfArgs = args.args !== undefined ? String(args.args) : previous?.args ?? "";
      const budgetTokens = Number(args.budgetTokens ?? settings.workflowTokenBudget) || undefined;
      const work = async (signal: AbortSignal, progress: (line: string) => void): Promise<JobOutcome> => {
        const run = runs.create(wf.name, wf.file, wfArgs, resumeId);
        const footer = `(workflow run ${run.id}; log: ${run.dir})`;
        try {
          const result = await runWorkflow(wf, wfArgs, {
            runTask,
            complete: (messages) => ctx.call("llm:invoke", messages, { maxTokens: 4096 }) as Promise<string>,
            maxRuns: settings.maxRunsPerWorkflow,
          }, signal, progress, { run, replay: resumeId ? runs.journal(resumeId) : undefined, budgetTokens });
          return { content: `${formatResult(result)}\n\n${footer}`, isError: false };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          progress(`failed: ${message}`);
          return { content: `Workflow "${wf.name}" failed: ${message}\n\n${footer}. Fix the cause, then resume it with ${WORKFLOW_TOOL} { resume: "${run.id}" }.`, isError: true };
        }
      };
      if (args.background) return startBackground(`workflow ${wf.name}`, work);
      return toolResult(await work(execCtx?.signal ?? new AbortController().signal, (line) => onChunk?.(`${line}\n`)));
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
  ctx.agent.registerSkill(
    "using-subagents",
    "Choosing between spawn_agent, parallel tasks, background runs and workflows; running, monitoring, resuming and debugging workflow runs",
    path.join(extDir, "USING.md"),
  );

  ctx.registerCommand("workflow", "Workflows: /workflow [<name> [args] | trust <name> | runs | resume <run id>]", (input) => {
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

    if (first === "runs") {
      const recent = runs.list();
      const message = recent.length
        ? recent.map(r => `${r.id}  ${r.workflow}  ${r.interrupted ? "interrupted" : r.status}  ${r.tokens} tokens` +
            `${r.resumedFrom ? `  (resumed from ${r.resumedFrom})` : ""}${r.error ? `\n    ${r.error}` : ""}`).join("\n")
        : "No workflow runs yet.";
      bus.emit("ui:info", { message });
      return;
    }

    if (first === "resume") {
      const record = runs.get(rest[0] ?? "");
      if (!record) { bus.emit("ui:error", { message: `No workflow run ${rest[0] ?? "(none given)"}. See /workflow runs.` }); return; }
      bus.emit("agent:submit", {
        query: `Resume workflow run ${record.id} (${record.workflow}) with ${WORKFLOW_TOOL} { resume: "${record.id}" }, then report its result.`,
      });
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

  ctx.agent.registerTool({
    name: JOBS_TOOL,
    description:
      "Manage background subagent runs: `list` them, get a finished run's `result`, `wait` for one (or all running) to finish, or `cancel` one.",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "result", "wait", "cancel"] },
        id: { type: "number", description: "Run number; for wait, omit to wait for all running runs" },
        timeoutSeconds: { type: "number", description: "wait only; default 600" },
      },
      required: ["action"],
    },
    getDisplayInfo: () => ({ kind: "execute", icon: "⤵" }),
    formatCall: (args) => [args.action, args.id !== undefined ? `#${args.id}` : ""].filter(Boolean).join(" "),

    async execute(args, _onChunk, execCtx) {
      const job = args.id === undefined ? undefined : jobs.get(Number(args.id));
      if (args.id !== undefined && !job) return error(`No background run #${args.id}.`);
      const ok = (content: string) => ({ content, exitCode: 0, isError: false });

      switch (args.action) {
        case "list":
          return ok(jobs.list().map(describe).join("\n") || "No background runs.");
        case "result":
          if (!job) return error("result needs an id.");
          if (job.status === "running") return ok(`${describe(job)}. Not finished; use wait to block until it is.`);
          return ok(jobs.read(job));
        case "wait": {
          const targets = job ? [job] : jobs.running();
          await jobs.wait(targets, Math.max(1, Number(args.timeoutSeconds ?? 600)) * 1000, execCtx?.signal);
          const finished = job ? (job.status === "running" ? [] : [job]) : jobs.unread();
          const still = targets.filter(j => j.status === "running");
          const parts = [
            ...finished.map(j => jobs.read(j)),
            ...(still.length ? [`Still running: ${still.map(describe).join("; ")}`] : []),
          ];
          return ok(parts.join("\n\n") || "No background runs to wait for.");
        }
        case "cancel":
          if (!job) return error("cancel needs an id.");
          if (job.status !== "running") return ok(`#${job.id} already ${job.status}.`);
          jobs.cancel(job);
          return ok(`Cancelled #${job.id}.`);
        default:
          return error(`Unknown action: ${args.action}`);
      }
    },
  });

  ctx.registerCommand("jobs", "List background subagent runs, or /jobs cancel <id>", (input) => {
    const [sub, id] = input.trim().split(/\s+/);
    if (sub === "cancel") {
      const job = jobs.get(Number(id));
      if (!job || job.status !== "running") { bus.emit("ui:error", { message: `No running background run #${id ?? ""}` }); return; }
      jobs.cancel(job);
      bus.emit("ui:info", { message: `Cancelled #${job.id}.` });
      return;
    }
    bus.emit("ui:info", { message: jobs.list().map(describe).join("\n") || "No background runs." });
  });

  ctx.registerCommand("agents", "List named subagents", () => {
    const agents = [...loadAgents().values()];
    const message = agents.length
      ? agents.map(a => `${a.name} — ${a.description}\n    ${a.source}`).join("\n")
      : `No agents found. Add markdown agent files to ${userDir}`;
    bus.emit("ui:info", { message });
  });

  function startBackground(label: string, work: (signal: AbortSignal, progress: (line: string) => void) => Promise<JobOutcome>) {
    const job = jobs.start(label, work);
    bus.emit("agent:pending-work-changed", {});
    return {
      content: `Started background run #${job.id} (${label}). Its status shows in your context; read the result with ${JOBS_TOOL} when it finishes.`,
      exitCode: 0,
      isError: false,
    };
  }

  async function runSpecs(
    specs: TaskSpec[],
    agents: Map<string, AgentDef>,
    signal?: AbortSignal,
    progress?: (line: string) => void,
  ): Promise<JobOutcome> {
    const results = await Promise.all(specs.map(async (spec, i) => {
      const name = spec.agent ?? "ad-hoc";
      const label = specs.length > 1 ? `[${i + 1} ${name}]` : `[${name}]`;
      const line = progress ? (l: string) => progress(`${label} ${l}`) : undefined;
      try {
        return { ok: true, text: await runOne(spec, spec.agent ? agents.get(spec.agent) : undefined, signal, line) };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        line?.(`failed: ${message}`);
        return { ok: false, text: `Subagent error: ${message}` };
      }
    }));

    if (specs.length === 1) {
      const r = results[0]!;
      return { content: r.text || "(no response)", isError: !r.ok };
    }
    const content = results.map((r, i) => {
      const s = specs[i]!;
      return `## [${i + 1}] ${s.agent ?? "ad-hoc"}${r.ok ? "" : " (failed)"}\n\n${r.text || "(no response)"}`;
    }).join("\n\n");
    return { content, isError: results.every(r => !r.ok) };
  }

  async function runTask(spec: RunSpec, ctl: TaskControl): Promise<TaskResult> {
    const def = spec.agent ? loadAgents().get(spec.agent) : undefined;
    if (spec.agent && !def) throw new Error(`unknown agent: ${spec.agent}`);
    if (!spec.schema) return { text: await runOne(spec, def, ctl.signal, ctl.progress, ctl) };

    // The schema becomes submit_result's parameters, so the agent fixes its own output.
    const schema = normalizeSchema(spec.schema);
    const wrapped = schema.type !== "object";
    const params = wrapped ? { type: "object", properties: { result: schema }, required: ["result"] } : schema;
    let submitted: { value: unknown } | undefined;
    const submit: ToolDefinition = {
      name: SUBMIT_TOOL,
      description: "Submit your final result; its arguments are the result. Call it once, when you are done.",
      input_schema: params,
      async execute(args) {
        const problem = validate(args, params);
        if (problem) return { content: `Invalid: ${problem}. Fix it and call ${SUBMIT_TOOL} again.`, exitCode: 1, isError: true };
        submitted = { value: wrapped ? (args as { result: unknown }).result : args };
        ctl.progress(SUBMIT_TOOL);
        return { content: "Recorded.", exitCode: 0, isError: false };
      },
    };
    const text = await runOne(spec, def, ctl.signal, ctl.progress, {
      ...ctl,
      extraTools: [submit],
      systemNote: `When you are done, call ${SUBMIT_TOOL} with your result.`,
      shouldStop: () => submitted !== undefined,
    });
    return { text, value: submitted?.value };
  }

  async function runOne(
    spec: TaskSpec,
    def: AgentDef | undefined,
    signal?: AbortSignal,
    progress?: (line: string) => void,
    extra: RunExtras = {},
  ): Promise<string> {
    const llmClient = ctx.call("llm:get-client") as SubagentOptions["llmClient"] | undefined;
    if (!llmClient) throw new Error("no LLM client available");

    const cwd = ctx.call("cwd") as string;
    const wanted = def ? def.tools : spec.tools;
    const tools = ctx.agent.getTools()
      .filter(t => !CHILD_EXCLUDED.has(t.name) && (!wanted || wanted.includes(t.name)))
      .map(t => throughHandlers(t, cwd, signal, progress))
      .concat(extra.extraTools ?? []);

    const parentContext = def?.inheritContext ? parentTranscript() : "";
    const systemPrompt = [
      def?.systemPrompt || "You are a focused subagent. Complete the task and return a clear, concise result.",
      `Working directory: ${cwd}`,
      extra.systemNote,
      parentContext && `[Parent conversation, most recent last]\n${parentContext}`,
    ].filter(Boolean).join("\n\n");

    const meta: SubagentRunMeta = {};
    await slots.acquire();
    let text: string;
    try {
      if (signal?.aborted) throw new Error("cancelled");
      text = await runSubagent({
        llmClient,
        tools,
        systemPrompt,
        task: spec.task,
        model: def?.model,
        signal,
        maxIterations: def?.maxIterations ?? settings.maxIterations,
        reasoningParams: reasoningParams(def?.thinking, def?.model ?? llmClient.model),
        outMeta: meta,
        onUsage: extra.onUsage ? (u) => extra.onUsage!(u.total_tokens || u.prompt_tokens + u.completion_tokens) : undefined,
        onMessage: extra.onMessage as SubagentOptions["onMessage"],
        shouldStop: extra.shouldStop,
      });
    } finally {
      slots.release();
    }
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

function toolResult(o: JobOutcome) {
  return { content: o.content, exitCode: o.isError ? 1 : 0, isError: o.isError };
}
