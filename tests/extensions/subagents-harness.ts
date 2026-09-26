/** Fake extension host for the subagents extension: scripted LLM, stub tools, captured commands. */
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../../src/core/event-bus.js";
import { HandlerRegistry } from "../../src/utils/handler-registry.js";
import type { ToolDefinition, ToolResult, ToolSchemaView } from "../../src/agent/types.js";
import activate from "../../examples/extensions/subagents/index.js";

export type Message = { role: string; content: string };
export type StreamOpts = { messages: Message[]; tools?: { function: { name: string } }[] };

export const lastUser = (o: { messages: Message[] }) =>
  String([...o.messages].reverse().find((m) => m.role === "user")?.content ?? "");

export interface HarnessOpts {
  /** Streaming subagent turns. */
  reply: (opts: StreamOpts) => Record<string, unknown>;
  /** One-shot completions (schema extraction). */
  invoke?: (messages: Message[]) => string;
  settings?: Record<string, unknown>;
}

export function setup(opts: HarnessOpts) {
  const root = mkdtempSync(join(tmpdir(), "subagents-"));
  const project = join(root, "project");
  mkdirSync(join(project, ".agent-sh", "agents"), { recursive: true });
  mkdirSync(join(project, ".agent-sh", "workflows"), { recursive: true });

  const bus = new EventBus();
  const h = new HandlerRegistry();
  const calls: StreamOpts[] = [];
  const invokes: Message[][] = [];
  h.define("cwd", () => project);
  h.define("agent:get-models", () => []);
  h.define("llm:get-client", () => ({
    model: "stub",
    stream: async (o: StreamOpts) => {
      calls.push(o);
      const delta = opts.reply(o);
      return (async function* () { yield { choices: [{ delta }] }; })();
    },
  }));
  h.define("llm:invoke", async (messages: Message[]) => {
    invokes.push(messages);
    if (!opts.invoke) throw new Error("no invoke scripted");
    return opts.invoke(messages);
  });

  const tools: ToolDefinition[] = [];
  const schemaAdvisors = new Map<string, (next: () => ToolSchemaView) => ToolSchemaView>();
  const commands = new Map<string, (args: string) => unknown>();
  const register = (t: ToolDefinition) => { tools.push(t); h.define(`tool:${t.name}`, t.execute.bind(t)); };
  for (const name of ["read_file", "grep", "bash"]) {
    register({
      name,
      description: name,
      input_schema: { type: "object", properties: {} },
      execute: async () => ({ content: `${name} ran`, exitCode: 0, isError: false }),
    });
  }

  const ctx = {
    bus,
    define: h.define.bind(h),
    advise: h.advise.bind(h),
    call: h.call.bind(h),
    getExtensionSettings: (_ns: string, d: object) => ({ ...d, ...opts.settings }),
    getStoragePath: (ns: string) => { const p = join(root, ns); mkdirSync(p, { recursive: true }); return p; },
    registerCommand: (name: string, _d: string, handler: (args: string) => unknown) => { commands.set(name, handler); },
    agent: {
      registerInstruction: () => {},
      registerSkill: () => {},
      registerTool: register,
      getTools: () => tools,
      adviseToolSchema: (n: string, a: (next: () => ToolSchemaView) => ToolSchemaView) => { schemaAdvisors.set(n, a); return () => {}; },
    },
  };
  activate(ctx as never);

  const tool = (name: string) => tools.find(t => t.name === name)!;
  const exec = (name: string, args: Record<string, unknown>, onChunk?: (c: string) => void): Promise<ToolResult> =>
    tool(name).execute(args, onChunk, {});
  return {
    bus,
    calls,
    invokes,
    h,
    root,
    project,
    run: (args: Record<string, unknown>, onChunk?: (c: string) => void) => exec("spawn_agent", args, onChunk),
    exec,
    command: (name: string, args: string) => commands.get(name)!(args),
    description: (name = "spawn_agent") => {
      const t = tool(name);
      return schemaAdvisors.get(name)!(() => ({ description: t.description, parameters: t.input_schema })).description;
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
