/**
 * Mode resolution is deferred to `core:extensions-loaded` so a persisted
 * `defaultProvider: "openrouter"` doesn't lose to a cold-start race.
 */
import "./events.js";
import type { ExtensionContext } from "../shell/host-types.js";
import type { AgentContext, AgentMode, AgentSurface, ProviderRegistration } from "../agent/host-types.js";
import type { AppConfig } from "../shell/host-types.js";
import { AgentLoop } from "./agent-loop.js";
import { LlmClient } from "./llm-client.js";
import { createLlmFacade } from "./llm-facade.js";
import type { ToolDefinition, ToolSchemaView } from "./types.js";
import { registerReadOnlyTool, unregisterReadOnlyTool } from "./nuclear-form.js";
import { resolveProvider, getProviderNames, getSettings, type ResolvedProvider } from "../core/settings.js";
import { discoverSkills } from "./skills.js";
import activateOpenrouter from "./providers/openrouter.js";
import activateOpenai from "./providers/openai.js";
import activateOpenaiCompatible from "./providers/openai-compatible.js";
import activateDeepseek from "./providers/deepseek.js";
import { findBash } from "../utils/executor.js";
import { createBashTool } from "./tools/bash.js";
import { createPwshTool } from "./tools/pwsh.js";
import { createReadFileTool, type FileReadCache } from "./tools/read-file.js";
import { createWriteFileTool } from "./tools/write-file.js";
import { createEditFileTool } from "./tools/edit-file.js";
import { createGrepTool } from "./tools/grep.js";
import { createGlobTool } from "./tools/glob.js";
import { createLsTool } from "./tools/ls.js";
import { createListSkillsTool } from "./tools/list-skills.js";

function persistedModelFor(providerName: string | undefined): string | undefined {
  if (!providerName) return undefined;
  return getSettings().providers?.[providerName]?.defaultModel;
}

type ModelCap = { reasoning?: boolean; contextWindow?: number; maxTokens?: number; echoReasoning?: boolean; modalities?: ("text" | "image")[] };

function defaultReasoningBuilder(level: string): Record<string, unknown> {
  if (level === "off") return {};
  return { reasoning_effort: level === "xhigh" ? "high" : level };
}

function mergeCaps(
  settingsCaps: Map<string, ModelCap> | undefined,
  payloadCaps: Map<string, ModelCap>,
  modelIds: string[],
): Map<string, ModelCap> | undefined {
  if (!settingsCaps) return payloadCaps.size > 0 ? payloadCaps : undefined;
  const out = new Map<string, ModelCap>();
  for (const id of modelIds) {
    const s = settingsCaps.get(id);
    const p = payloadCaps.get(id);
    if (!s && !p) continue;
    out.set(id, {
      reasoning: s?.reasoning ?? p?.reasoning,
      contextWindow: s?.contextWindow ?? p?.contextWindow,
      maxTokens: s?.maxTokens ?? p?.maxTokens,
      echoReasoning: s?.echoReasoning ?? p?.echoReasoning,
    });
  }
  return out.size > 0 ? out : undefined;
}

function splitRegistration(p: ProviderRegistration): { ids: string[]; caps: Map<string, ModelCap> } {
  const raw = p.models ?? (p.defaultModel ? [p.defaultModel] : []);
  const ids: string[] = [];
  const caps = new Map<string, ModelCap>();
  for (const m of raw) {
    if (typeof m === "string") {
      ids.push(m);
    } else {
      ids.push(m.id);
      caps.set(m.id, { reasoning: m.reasoning, contextWindow: m.contextWindow, maxTokens: m.maxTokens, echoReasoning: m.echoReasoning, modalities: m.modalities });
    }
  }
  return { ids, caps };
}

export default function agentBackend(ctx: ExtensionContext): void {
  const { bus } = ctx;
  const config: AppConfig = ctx.call("config:get-app-config") ?? {};

  type ToolContributor = (acc: { tools: ToolDefinition[] }) => { tools: ToolDefinition[] };
  type InstructionContributor = (acc: { instructions: Array<{ name: string; text: string }> }) => { instructions: Array<{ name: string; text: string }> };
  type SkillContributor = (acc: { skills: Array<{ name: string; description: string; filePath: string }> }) => { skills: Array<{ name: string; description: string; filePath: string }> };
  type ProviderContributor = (acc: { providers: ProviderRegistration[] }) => { providers: ProviderRegistration[] };

  const toolContribs = new Map<string, ToolContributor>();
  const instructionContribs = new Map<string, InstructionContributor>();
  const skillContribs = new Map<string, SkillContributor>();
  const providerContribs = new Map<string, ProviderContributor>();

  // Settings overlay — fields here win over contributing extensions' payloads.
  const settingsProviders = new Map<string, ResolvedProvider>();
  for (const name of getProviderNames()) {
    const p = resolveProvider(name);
    if (p) settingsProviders.set(name, p);
  }

  const providerHooks = new Map<string, { reasoningParams?: (level: string, model?: string) => Record<string, unknown> }>();

  // Bakes model id so AgentMode.buildReasoningParams keeps its (level) signature.
  const bindReasoning = (shapeId: string, model: string) => {
    const hook = providerHooks.get(shapeId)?.reasoningParams;
    return hook ? (level: string) => hook(level, model) : defaultReasoningBuilder;
  };

  const agentSurface: AgentSurface = {
    llm: createLlmFacade({ list: ctx.list, call: ctx.call }),
    providers: {
      register: (reg) => {
        const existing = providerContribs.get(reg.id);
        if (existing) bus.offPipe("agent:providers", existing);
        const contrib: ProviderContributor = (acc) => {
          acc.providers.push(reg);
          return acc;
        };
        providerContribs.set(reg.id, contrib);
        bus.onPipe("agent:providers", contrib);
        bus.emit("agent:providers:changed", {});
        return () => agentSurface.providers.unregister(reg.id);
      },
      unregister: (id) => {
        const contrib = providerContribs.get(id);
        if (!contrib) return;
        bus.offPipe("agent:providers", contrib);
        providerContribs.delete(id);
        bus.emit("agent:providers:changed", {});
      },
      configure: (id, configureOpts) => bus.emit("provider:configure", { id, ...configureOpts }),
    },
    registerTool: (tool) => {
      if (toolContribs.has(tool.name)) {
        throw new Error(`Tool "${tool.name}" already registered. Use ctx.agent.adviseTool() to wrap it.`);
      }
      ctx.define(`tool:${tool.name}`, tool.execute.bind(tool));
      ctx.define(`tool:${tool.name}:schema`, (): ToolSchemaView => ({
        description: tool.description,
        parameters: tool.input_schema,
      }));
      if (tool.readOnly) registerReadOnlyTool(tool.name);
      else unregisterReadOnlyTool(tool.name);
      const contrib: ToolContributor = (acc) => {
        // Pull through schema so adviseToolSchema reflects.
        const view = ctx.call(`tool:${tool.name}:schema`) as ToolSchemaView;
        acc.tools.push({ ...tool, description: view.description, input_schema: view.parameters });
        return acc;
      };
      toolContribs.set(tool.name, contrib);
      bus.onPipe("agent:tools", contrib);
    },
    unregisterTool: (name) => {
      const contrib = toolContribs.get(name);
      if (!contrib) return;
      bus.offPipe("agent:tools", contrib);
      toolContribs.delete(name);
      unregisterReadOnlyTool(name);
      // Handlers retained so external advisors survive a reload.
    },
    adviseTool: (name, advisor) => ctx.advise(`tool:${name}`, advisor as Parameters<typeof ctx.advise>[1]),
    adviseToolSchema: (name, advisor) => ctx.advise(`tool:${name}:schema`, advisor as Parameters<typeof ctx.advise>[1]),
    getTools: () => bus.emitPipe("agent:tools", { tools: [] }).tools,
    registerInstruction: (name, text) => {
      const existing = instructionContribs.get(name);
      if (existing) bus.offPipe("agent:instructions", existing);
      ctx.define(`instruction:${name}`, () => text);
      const contrib: InstructionContributor = (acc) => {
        const current = ctx.call(`instruction:${name}`) as string;
        acc.instructions.push({ name, text: current });
        return acc;
      };
      instructionContribs.set(name, contrib);
      bus.onPipe("agent:instructions", contrib);
    },
    removeInstruction: (name) => {
      const contrib = instructionContribs.get(name);
      if (!contrib) return;
      bus.offPipe("agent:instructions", contrib);
      instructionContribs.delete(name);
    },
    adviseInstruction: (name, advisor) => ctx.advise(`instruction:${name}`, advisor as Parameters<typeof ctx.advise>[1]),
    registerSkill: (name, description, filePath) => {
      const existing = skillContribs.get(name);
      if (existing) bus.offPipe("agent:skills", existing);
      ctx.define(`skill:${name}:view`, () => ({ description, filePath }));
      const contrib: SkillContributor = (acc) => {
        const view = ctx.call(`skill:${name}:view`) as { description: string; filePath: string };
        acc.skills.push({ name, description: view.description, filePath: view.filePath });
        return acc;
      };
      skillContribs.set(name, contrib);
      bus.onPipe("agent:skills", contrib);
    },
    removeSkill: (name) => {
      const contrib = skillContribs.get(name);
      if (!contrib) return;
      bus.offPipe("agent:skills", contrib);
      skillContribs.delete(name);
    },
    adviseSkill: (name, advisor) => ctx.advise(`skill:${name}:view`, advisor as Parameters<typeof ctx.advise>[1]),
    registerContextProducer: (_name, producer, producerOpts) => {
      const handlerName = producerOpts?.mode === "per-query"
        ? "query-context:build"
        : "dynamic-context:build";
      return ctx.advise(handlerName, (next) => {
        const base = next() as string;
        const part = producer();
        if (!part) return base;
        const trimmed = part.trim();
        if (!trimmed) return base;
        return base ? `${base}\n\n${trimmed}` : trimmed;
      });
    },
  };
  (ctx as { agent?: AgentSurface }).agent = agentSurface;

  // Core tools register at activate — before extensions load — so
  // extensions that look them up at activate time (e.g. scheme.ts) find them.
  // conversation_recall stays in AgentLoop (needs session state).
  const fileReadCache: FileReadCache = new Map();
  ctx.define("agent:file-read-cache", () => fileReadCache);
  const getCwd = () => ctx.call("cwd") as string;
  const getEnv = () => {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) env[k] = v;
    }
    return env;
  };
  if (findBash() !== null) {
    agentSurface.registerTool(createBashTool({ getCwd, getEnv, bus }));
  }
  if (process.platform === "win32") {
    agentSurface.registerTool(createPwshTool({ getCwd, getEnv, bus }));
  }
  agentSurface.registerTool(createReadFileTool(getCwd, fileReadCache));
  agentSurface.registerTool(createWriteFileTool(getCwd));
  agentSurface.registerTool(createEditFileTool(getCwd));
  agentSurface.registerTool(createGrepTool(getCwd));
  agentSurface.registerTool(createGlobTool(getCwd));
  agentSurface.registerTool(createLsTool(getCwd));
  agentSurface.registerTool(createListSkillsTool(getCwd));

  let resolvedProviders = new Map<string, ResolvedProvider>();

  const resolveWithSettings = (id: string, p: ProviderRegistration | null): ResolvedProvider => {
    const s = settingsProviders.get(id);
    const { ids: payloadIds, caps: payloadCaps } = p ? splitRegistration(p) : { ids: [], caps: new Map<string, ModelCap>() };
    const fallbackIds = s?.models ?? (s?.defaultModel ? [s.defaultModel] : []);
    const modelIds = s?.modelsExplicit && s.models.length > 0
      ? s.models
      : payloadIds.length > 0 ? payloadIds : fallbackIds;
    return {
      id,
      apiKey: s?.apiKey ?? p?.apiKey,
      baseURL: s?.baseURL ?? p?.baseURL,
      defaultModel: s?.defaultModel ?? p?.defaultModel ?? modelIds[0],
      models: modelIds,
      modelsExplicit: s?.modelsExplicit ?? false,
      contextWindow: s?.contextWindow,
      supportsReasoningEffort: s?.supportsReasoningEffort ?? p?.supportsReasoningEffort,
      modelCapabilities: mergeCaps(s?.modelCapabilities, payloadCaps, modelIds),
      reasoningShape: s?.reasoningShape,
    };
  };

  const computeResolvedProviders = (): Map<string, ResolvedProvider> => {
    const out = new Map<string, ResolvedProvider>();
    // Last contribution per id wins (openrouter's catalog-refresh replaces
    // its curated default).
    const { providers } = bus.emitPipe("agent:providers", { providers: [] as ProviderRegistration[] });
    const byId = new Map<string, ProviderRegistration>();
    for (const p of providers) byId.set(p.id, p);
    for (const [id, p] of byId) out.set(id, resolveWithSettings(id, p));
    for (const [id] of settingsProviders) {
      if (out.has(id)) continue;
      out.set(id, resolveWithSettings(id, null));
    }
    return out;
  };

  const buildModes = (): AgentMode[] => {
    const out: AgentMode[] = [];
    for (const [id, p] of resolvedProviders) {
      if (!p.apiKey) continue;
      const shapeId = p.reasoningShape ?? id;
      for (const model of p.models) {
        const mc = p.modelCapabilities?.get(model);
        out.push({
          model,
          provider: id,
          providerConfig: { apiKey: p.apiKey, baseURL: p.baseURL },
          contextWindow: mc?.contextWindow ?? p.contextWindow,
          maxTokens: mc?.maxTokens ?? (mc?.contextWindow ? Math.min(Math.floor(mc.contextWindow * 0.4), 65536) : undefined),
          reasoning: mc?.reasoning,
          supportsReasoningEffort: p.supportsReasoningEffort,
          echoReasoning: mc?.echoReasoning,
          modalities: mc?.modalities,
          buildReasoningParams: bindReasoning(shapeId, model),
        });
      }
    }
    return out;
  };

  ctx.define("agent:get-modes", () => buildModes());

  // Reconfigured at core:extensions-loaded; start() gates on `resolved`.
  const llmClient = new LlmClient({ apiKey: "not-configured", model: "not-configured" });
  ctx.define("llm:get-client", () => llmClient);
  ctx.define("llm:invoke", (messages: { role: string; content: string }[], opts?: { maxTokens?: number; model?: string; reasoningEffort?: string }) => {
    const effort = opts?.reasoningEffort;
    const clampedEffort = effort === "xhigh" ? "high" : effort;
    return llmClient.complete({
      messages: messages as Parameters<typeof llmClient.complete>[0]["messages"],
      max_tokens: opts?.maxTokens,
      model: opts?.model,
      ...(clampedEffort && clampedEffort !== "off" ? { reasoning_effort: clampedEffort } : {}),
    });
  });

  let resolved = false;
  // Gates late-reconcile so config:switch-model doesn't misroute under a non-ash backend.
  let ashActive = false;
  let agentLoop: AgentLoop | null = null;
  let loadedExtensionNames: string[] = [];

  bus.on("agent:providers:changed", () => {
    resolvedProviders = computeResolvedProviders();
    if (!resolved) return;
    bus.emit("agent:modes-changed", {});
    if (!ashActive) return;
    const pendingProvider = getSettings().defaultProvider;
    if (!pendingProvider) return;
    const p = resolvedProviders.get(pendingProvider);
    if (!p) return;
    const pendingModel = persistedModelFor(pendingProvider);
    if (pendingModel && p.models.includes(pendingModel) && llmClient.model !== pendingModel) {
      bus.emit("config:switch-model", { model: pendingModel });
    }
  });

  bus.on("provider:configure", ({ id, reasoningParams }) => {
    const prev = providerHooks.get(id) ?? {};
    if (reasoningParams !== undefined) prev.reasoningParams = reasoningParams;
    providerHooks.set(id, prev);
  });

  bus.on("core:extensions-loaded", ({ names }) => {
    loadedExtensionNames = names;
    resolvedProviders = computeResolvedProviders();

    const settings = getSettings();
    const providerName = config.provider ?? settings.defaultProvider
      ?? (resolvedProviders.size > 0 ? resolvedProviders.keys().next().value : undefined);
    const activeProvider = providerName ? resolvedProviders.get(providerName) ?? null : null;

    // Persisted defaultModel wins over openrouter's hardcoded DEFAULT_MODELS[0].
    const effectiveApiKey = config.apiKey ?? activeProvider?.apiKey;
    const effectiveBaseURL = config.baseURL ?? activeProvider?.baseURL;
    const effectiveModel = config.model ?? persistedModelFor(providerName) ?? activeProvider?.defaultModel;

    // No provider → don't register ash; let another backend own activation.
    if (!effectiveApiKey || !effectiveModel) return;

    const foundInModes = buildModes().find(
      (m) => m.model === effectiveModel && (!activeProvider || m.provider === activeProvider.id),
    );
    // Stub when openrouter's async catalog hasn't returned yet; reconciled
    // later via agent:providers:changed → config:switch-model.
    const initialMode: AgentMode = foundInModes ?? (activeProvider ? {
      model: effectiveModel,
      provider: activeProvider.id,
      providerConfig: { apiKey: effectiveApiKey, baseURL: effectiveBaseURL },
      supportsReasoningEffort: activeProvider.supportsReasoningEffort,
    } : { model: effectiveModel });

    llmClient.reconfigure({ apiKey: effectiveApiKey, baseURL: effectiveBaseURL, model: effectiveModel });
    resolved = true;

    bus.emit("agent:register-backend", {
      name: "ash",
      kill: () => {
        ashActive = false;
        bus.emit("command:unregister", { name: "/compact" });
        bus.emit("command:unregister", { name: "/context" });
        agentLoop?.kill();
        agentLoop = null;
      },
      start: async () => {
        agentLoop = new AgentLoop({
          bus,
          llmClient,
          handlers: { define: ctx.define, advise: ctx.advise, call: ctx.call, list: ctx.list },
          initialMode,
          compositor: ctx.shell?.compositor,
          instanceId: ctx.instanceId,
          history: config.history,
        });
        agentLoop.wire();
        ashActive = true;
        bus.emit("command:register", {
          name: "/compact",
          description: "Compact conversation via the active compaction strategy",
          handler: () => bus.emit("agent:compact-request", {}),
        });
        bus.emit("command:register", {
          name: "/context",
          description: "Show context budget usage",
          handler: () => {
            const stats = bus.emitPipe("context:get-stats", {
              activeTokens: 0,
              totalTokens: 0,
              budgetTokens: 0,
            });
            const pct = stats.budgetTokens > 0
              ? Math.round((stats.activeTokens / stats.budgetTokens) * 100)
              : 0;
            bus.emit("ui:info", {
              message: `Active context: ~${stats.activeTokens.toLocaleString()} tokens / ${stats.budgetTokens.toLocaleString()} budget (${pct}%)`,
            });
          },
        });
      },
    });
  });

  bus.on("config:switch-provider", ({ provider: name }) => {
    const p = resolvedProviders.get(name);
    if (!p) {
      bus.emit("ui:error", { message: `Unknown provider: ${name}` });
      return;
    }
    if (!p.apiKey) {
      bus.emit("ui:error", { message: `Provider "${name}" has no API key configured` });
      return;
    }
    const switchModel = p.defaultModel ?? p.models[0];
    if (!switchModel) {
      bus.emit("ui:error", { message: `Provider "${name}" has no models configured` });
      return;
    }
    llmClient.reconfigure({ apiKey: p.apiKey, baseURL: p.baseURL, model: switchModel });
    bus.emit("agent:modes-changed", {});
    bus.emit("config:switch-model", { model: switchModel });
    bus.emit("ui:info", { message: `Switched to ${name} (${switchModel})` });
  });

  bus.onPipe("banner:collect", (e) => {
    if (e.activeBackend && e.activeBackend !== "ash") return e;
    if (loadedExtensionNames.length > 0) {
      e.sections.push({ label: "Extensions", items: [...loadedExtensionNames] });
    }
    const skills = discoverSkills(ctx.call("cwd") ?? process.cwd());
    if (skills.length > 0) {
      e.sections.push({ label: "Skills", items: skills.map((s) => s.name) });
    }
    return e;
  });
}

export type { AgentBackend } from "./types.js";
export type { ToolDefinition, ToolResult, ToolDisplayInfo } from "./types.js";
export { AgentLoop } from "./agent-loop.js";
export { ToolRegistry } from "./tool-registry.js";
export { runSubagent, type SubagentOptions } from "./subagent.js";

/** Built-in providers register unconditionally so `auth list` can
 *  enumerate them; buildModes() skips entries without an apiKey. */
export function activateAgent(ctx: ExtensionContext): void {
  agentBackend(ctx);
  const agentCtx = ctx as AgentContext;
  activateOpenrouter(agentCtx);
  activateOpenai(agentCtx);
  if (process.env.OPENAI_BASE_URL) activateOpenaiCompatible(agentCtx);
  activateDeepseek(agentCtx);
}
