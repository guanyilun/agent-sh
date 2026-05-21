/**
 * Provider/mode resolution is deferred to `core:extensions-loaded` so
 * runtime-registered providers (e.g. openrouter) have a chance to
 * contribute before we look up settings.defaultProvider. Without this
 * deferral, a persisted `defaultProvider: "openrouter"` loses to a
 * cold-start race and the backend bails silently.
 *
 * Provider registry is pull-composed via the `agent:providers` pipe —
 * the listener list IS the registry. agentBackend recomputes its
 * derived mode catalog on every `agent:providers:changed` notification
 * and emits `agent:modes-changed` so AgentLoop can pull fresh.
 */
import "./events.js"; // augments BusEvents with ash-owned events
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

function persistedModelFor(providerName: string | undefined): string | undefined {
  if (!providerName) return undefined;
  return getSettings().providers?.[providerName]?.defaultModel;
}

type ModelCap = { reasoning?: boolean; contextWindow?: number; maxTokens?: number; echoReasoning?: boolean };

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

/** Split a ProviderRegistration's models field into ids + caps. */
function splitRegistration(p: ProviderRegistration): { ids: string[]; caps: Map<string, ModelCap> } {
  const raw = p.models ?? (p.defaultModel ? [p.defaultModel] : []);
  const ids: string[] = [];
  const caps = new Map<string, ModelCap>();
  for (const m of raw) {
    if (typeof m === "string") {
      ids.push(m);
    } else {
      ids.push(m.id);
      caps.set(m.id, { reasoning: m.reasoning, contextWindow: m.contextWindow, maxTokens: m.maxTokens, echoReasoning: m.echoReasoning });
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

  // Settings overlay snapshot, captured at activate. Layered onto every
  // pulled ProviderRegistration during merge — apiKey / baseURL /
  // defaultModel / modelsExplicit / modelCapabilities all override the
  // contributing extension's payload.
  const settingsProviders = new Map<string, ResolvedProvider>();
  for (const name of getProviderNames()) {
    const p = resolveProvider(name);
    if (p) settingsProviders.set(name, p);
  }

  const providerHooks = new Map<string, { reasoningParams?: (level: string, model?: string) => Record<string, unknown> }>();

  // Bakes model id into the hook so AgentMode.buildReasoningParams keeps
  // its (level) signature while the hook can branch on model.
  const bindReasoning = (shapeId: string, model: string) => {
    const hook = providerHooks.get(shapeId)?.reasoningParams;
    return hook ? (level: string) => hook(level, model) : defaultReasoningBuilder;
  };

  const agentSurface: AgentSurface = {
    llm: createLlmFacade({ list: ctx.list, call: ctx.call }),
    providers: {
      register: (reg) => {
        // Replace any prior contribution from this caller for this id.
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
        // Pull through tool:NAME:schema so adviseToolSchema reflects.
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
      // Handler entries retained so external advisors survive a reload.
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

  // Cache of resolved providers — settings-overlaid registrations
  // keyed by id. Rebuilt on every agent:providers:changed.
  let resolvedProviders = new Map<string, ResolvedProvider>();

  /** Apply the settings overlay onto a registration (or synthesize a
   *  registration from settings when no extension contributed). */
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
    // Pull extension contributions. Last contribution per id wins so
    // openrouter's catalog-refresh re-registration replaces the curated
    // default — providerContribs already enforces one entry per id, but
    // pipe order is install order; here we want most-recent semantics.
    const { providers } = bus.emitPipe("agent:providers", { providers: [] as ProviderRegistration[] });
    const byId = new Map<string, ProviderRegistration>();
    for (const p of providers) byId.set(p.id, p);
    for (const [id, p] of byId) out.set(id, resolveWithSettings(id, p));
    // Fill settings-only providers (declared in settings.json with no
    // extension contributing) — they enter the system as overlay-only.
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
          buildReasoningParams: bindReasoning(shapeId, model),
        });
      }
    }
    return out;
  };

  // Pulled by AgentLoop on every agent:modes-changed and by config:get-models.
  ctx.define("agent:get-modes", () => buildModes());

  // Placeholder client — reconfigured at core:extensions-loaded. Any
  // stream() call before then fails from the OpenAI SDK; start() won't
  // wire the loop until we've resolved, so users never hit that path.
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
  // Gates late-registration reconcile so its config:switch-model emit doesn't misroute under a non-ash backend.
  let ashActive = false;
  let agentLoop: AgentLoop | null = null;
  let loadedExtensionNames: string[] = [];

  // Recompute on every providers change, then notify AgentLoop. For
  // the late-reconcile case (catalog arrives after boot and contains
  // the persisted default), nudge AgentLoop onto it.
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

    // User's persisted defaultModel wins over the provider's declared
    // default. Dynamic providers (openrouter) re-register with their
    // hardcoded DEFAULT_MODELS[0] each startup, which would otherwise
    // clobber the user's /model selection.
    const effectiveApiKey = config.apiKey ?? activeProvider?.apiKey;
    const effectiveBaseURL = config.baseURL ?? activeProvider?.baseURL;
    const effectiveModel = config.model ?? persistedModelFor(providerName) ?? activeProvider?.defaultModel;

    // No provider → don't register ash at all, so another backend (e.g.
    // claude-code-bridge) can own activation. CLI hard-fails only
    // when no backend ended up registered.
    if (!effectiveApiKey || !effectiveModel) return;

    const foundInModes = buildModes().find(
      (m) => m.model === effectiveModel && (!activeProvider || m.provider === activeProvider.id),
    );
    // Stub when the persisted default isn't in the provider's curated list
    // yet (e.g. openrouter's async catalog fetch hasn't returned). The late
    // catalog will reconcile via agent:providers:changed → config:switch-model.
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

/** Activate the ash backend and every built-in provider. Providers
 *  register unconditionally so `agent-sh auth list` can enumerate them;
 *  `buildModes()` skips entries without an apiKey. */
export function activateAgent(ctx: ExtensionContext): void {
  agentBackend(ctx);
  const agentCtx = ctx as AgentContext;
  activateOpenrouter(agentCtx);
  activateOpenai(agentCtx);
  if (process.env.OPENAI_BASE_URL) activateOpenaiCompatible(agentCtx);
  activateDeepseek(agentCtx);
}
