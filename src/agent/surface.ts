/** Shared agent extension surface. No provider discovery, model loop or frontend. */
import type { ExtensionContext } from "../shell/host-types.js";
import type { AgentSurface } from "./host-types.js";
import type { ToolDefinition, ToolSchemaView } from "./types.js";
import { createLlmFacade } from "./llm-facade.js";
import { extensionHostContext } from "../core/extension-loader.js";
import { ensureToolDispatcher } from "./tool-dispatch.js";

export function attachAgentSurface(context: ExtensionContext): AgentSurface {
  const ctx = extensionHostContext(context);
  if (ctx.agent) return ctx.agent;
  const { bus } = ctx;
  const tools = new Map<string, (acc: { tools: ToolDefinition[] }) => { tools: ToolDefinition[] }>();
  const instructions = new Map<string, (acc: { instructions: Array<{ name: string; text: string }> }) => typeof acc>();
  const skills = new Map<string, (acc: { skills: Array<{ name: string; description: string; filePath: string }> }) => typeof acc>();
  const providers = new Map<string, () => void>();
  let replacingProvider = false;
  const surface: AgentSurface = {
    llm: createLlmFacade({ list: ctx.list, call: ctx.call }),
    providers: {
      register(reg) {
        const previous = providers.get(reg.id);
        // Replacement is atomic to observers: no transient empty catalog.
        replacingProvider = true;
        try { previous?.(); } finally { replacingProvider = false; }
        const contribute = (acc: { providers: typeof reg[] }) => { acc.providers.push(reg); return acc; };
        bus.onPipe("agent:providers", contribute);
        const dispose = () => {
          bus.offPipe("agent:providers", contribute);
          if (providers.get(reg.id) !== dispose) return;
          providers.delete(reg.id);
          if (!replacingProvider) bus.emit("agent:providers:changed", {});
        };
        providers.set(reg.id, dispose);
        bus.emit("agent:providers:changed", {});
        return dispose;
      },
      unregister(id) { providers.get(id)?.(); },
      configure(id, options) { bus.emit("provider:configure", { id, ...options }); },
    },
    registerTool(tool) {
      if (tools.has(tool.name)) throw new Error(`Tool "${tool.name}" already registered. Use ctx.agent.adviseTool() to wrap it.`);
      ctx.define(`tool:${tool.name}`, tool.execute.bind(tool));
      ctx.define(`tool:${tool.name}:schema`, (): ToolSchemaView => ({ description: tool.description, parameters: tool.input_schema }));
      const contribute = (acc: { tools: ToolDefinition[] }) => {
        const view = ctx.call(`tool:${tool.name}:schema`) as ToolSchemaView;
        acc.tools.push({ ...tool, description: view.description, input_schema: view.parameters });
        return acc;
      };
      tools.set(tool.name, contribute);
      bus.onPipe("agent:tools", contribute);
    },
    unregisterTool(name) {
      const contribute = tools.get(name);
      if (contribute) bus.offPipe("agent:tools", contribute);
      tools.delete(name);
    },
    adviseTool: (name, advisor) => ctx.advise(`tool:${name}`, advisor),
    adviseToolSchema: (name, advisor) => ctx.advise(`tool:${name}:schema`, advisor),
    getTools: () => bus.emitPipe("agent:tools", { tools: [] }).tools,
    registerInstruction(name, text) {
      surface.removeInstruction(name);
      ctx.define(`instruction:${name}`, () => text);
      const contribute = (acc: { instructions: Array<{ name: string; text: string }> }) => {
        acc.instructions.push({ name, text: ctx.call(`instruction:${name}`) }); return acc;
      };
      instructions.set(name, contribute);
      bus.onPipe("agent:instructions", contribute);
    },
    removeInstruction(name) {
      const contribute = instructions.get(name);
      if (contribute) bus.offPipe("agent:instructions", contribute);
      instructions.delete(name);
    },
    adviseInstruction: (name, advisor) => ctx.advise(`instruction:${name}`, advisor),
    registerSkill(name, description, filePath) {
      surface.removeSkill(name);
      ctx.define(`skill:${name}:view`, () => ({ description, filePath }));
      const contribute = (acc: { skills: Array<{ name: string; description: string; filePath: string }> }) => {
        acc.skills.push({ name, ...ctx.call(`skill:${name}:view`) }); return acc;
      };
      skills.set(name, contribute);
      bus.onPipe("agent:skills", contribute);
    },
    removeSkill(name) {
      const contribute = skills.get(name);
      if (contribute) bus.offPipe("agent:skills", contribute);
      skills.delete(name);
    },
    adviseSkill: (name, advisor) => ctx.advise(`skill:${name}:view`, advisor),
    registerContextProducer(_name, producer, options) {
      return ctx.advise(options?.mode === "per-query" ? "query-context:build" : "dynamic-context:build", (next) => {
        const base = next() as string;
        const part = producer()?.trim();
        return part ? (base ? `${base}\n\n${part}` : part) : base;
      });
    },
  };
  ctx.agent = surface;
  ensureToolDispatcher(ctx);
  // Classification is instance-local; compaction extensions can query this handler.
  ctx.define("agent:is-read-only-tool", (name: string) => surface.getTools().find(t => t.name === name)?.readOnly);
  ctx.onDispose(() => {
    for (const name of [...tools.keys()]) surface.unregisterTool(name);
    for (const name of [...instructions.keys()]) surface.removeInstruction(name);
    for (const name of [...skills.keys()]) surface.removeSkill(name);
    for (const dispose of [...providers.values()]) dispose();
  });
  return surface;
}
