/**
 * Mode resolution is deferred to `core:extensions-loaded` so a persisted
 * `defaultProvider: "openrouter"` doesn't lose to a cold-start race.
 */
import "./events.js";
import type { ExtensionContext } from "../shell/host-types.js";
import type { AgentContext, Model, ModelEndpoint, AgentSurface, ProviderRegistration } from "../agent/host-types.js";
import type { AppConfig } from "../shell/host-types.js";
import { AgentLoop } from "./agent-loop.js";
import { LlmClient } from "./llm-client.js";
import { attachAgentSurface } from "./surface.js";
import { bindLlmClient } from "./llm-binding.js";
import {
  globalSettingsService,
  type SettingsService,
  type ResolvedProvider,
} from "../core/settings.js";
import { resolveApiKey } from "../cli/auth/keys.js";
import { discoverSkills } from "./skills.js";
import activateOpenrouter from "./providers/openrouter.js";
import activateOpenai from "./providers/openai.js";
import activateOpenaiCompatible from "./providers/openai-compatible.js";
import activateDeepseek from "./providers/deepseek.js";
import activateOllama from "./providers/ollama.js";
import activateZaiCodingPlan from "./providers/zai-coding-plan.js";
import activateOpencode from "./providers/opencode.js";
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

/** The OpenAI SDK silently defaults an empty baseURL to api.openai.com, so a
 *  provider with a key but no endpoint would misroute its key there. `openai`
 *  is exempt: that default is its endpoint. */
function usableProvider(p: ResolvedProvider | null | undefined): boolean {
  return !!p?.apiKey && (!!p.baseURL || p.id === "openai");
}

type ModelCap = { reasoning?: boolean; contextWindow?: number; maxTokens?: number; echoReasoning?: boolean; modalities?: ("text" | "image")[] };

function defaultReasoningBuilder(level: string): Record<string, unknown> {
  if (level === "off") return {};
  return { reasoning_effort: level === "xhigh" ? "high" : level };
}

function defaultCacheTokens(usage: Record<string, unknown>): number | undefined {
  const details = usage.prompt_tokens_details as { cached_tokens?: number } | undefined;
  return typeof details?.cached_tokens === "number" ? details.cached_tokens : undefined;
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
      modalities: s?.modalities ?? p?.modalities,
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
  const settingsService: SettingsService = ctx.call("config:settings") ?? config.settingsService ?? config.settings ?? globalSettingsService;
  const persistedModelFor = (providerName: string | undefined): string | undefined =>
    providerName ? settingsService.get().providers?.[providerName]?.defaultModel : undefined;

  // Settings overlay — fields here win over contributing extensions' payloads.
  const settingsProviders = new Map<string, ResolvedProvider>();
  const refreshSettingsProviders = () => {
    settingsProviders.clear();
    for (const name of settingsService.getProviderNames()) {
      const p = settingsService.resolveProvider(name);
      if (p) settingsProviders.set(name, p);
    }
  };
  refreshSettingsProviders();

  const providerHooks = new Map<string, {
    reasoningParams?: (level: string, model?: string) => Record<string, unknown>;
    cacheTokens?: (usage: Record<string, unknown>) => number | undefined;
    requestHeaders?: (info: { sessionId?: string }) => Record<string, string>;
  }>();

  // Bakes model id so ModelEndpoint.buildReasoningParams keeps its (level) signature.
  const bindReasoning = (shapeId: string, model: string) => {
    const hook = providerHooks.get(shapeId)?.reasoningParams;
    return hook ? (level: string) => hook(level, model) : defaultReasoningBuilder;
  };

  const bindCacheTokens = (shapeId: string) =>
    providerHooks.get(shapeId)?.cacheTokens ?? defaultCacheTokens;

  const bindRequestHeaders = (shapeId: string) =>
    providerHooks.get(shapeId)?.requestHeaders;

  const agentSurface = attachAgentSurface(ctx);

  ctx.define("provider:resolve-api-key", (id: string) => resolveApiKey(id));

  // Core tools register at activate — before extensions load — so
  // extensions that look them up at activate time (e.g. scheme.ts) find them.
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
      // keys.json fallback for settings-only providers (auth login)
      apiKey: s?.apiKey ?? p?.apiKey ?? resolveApiKey(id).key ?? undefined,
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

  const buildModels = (): Model[] => {
    const out: Model[] = [];
    for (const [id, p] of resolvedProviders) {
      if (!p.apiKey) continue;
      if (!usableProvider(p)) continue;
      for (const model of p.models) {
        const mc = p.modelCapabilities?.get(model);
        out.push({
          id: model,
          provider: id,
          contextWindow: mc?.contextWindow ?? p.contextWindow,
          maxTokens: mc?.maxTokens ?? (mc?.contextWindow ? Math.min(Math.floor(mc.contextWindow * 0.4), 65536) : undefined),
          reasoning: mc?.reasoning,
          supportsReasoningEffort: p.supportsReasoningEffort,
          echoReasoning: mc?.echoReasoning,
          modalities: mc?.modalities,
        });
      }
    }
    return out;
  };

  const resolveEndpoint = (providerId: string, modelId: string): ModelEndpoint | undefined => {
    const p = resolvedProviders.get(providerId);
    if (!p?.apiKey) return undefined;
    const shapeId = p.reasoningShape ?? providerId;
    return {
      apiKey: p.apiKey,
      baseURL: p.baseURL,
      buildReasoningParams: bindReasoning(shapeId, modelId),
      extractCachedTokens: bindCacheTokens(shapeId),
      buildRequestHeaders: bindRequestHeaders(shapeId),
    };
  };

  ctx.define("agent:get-models", () => buildModels());
  ctx.define("agent:resolve-endpoint", ({ provider, id }: { provider: string; id: string }) => resolveEndpoint(provider, id));

  // Reconfigured at core:extensions-loaded; start() gates on `resolved`.
  const llmClient = new LlmClient({ apiKey: "not-configured", model: "not-configured" });
  bindLlmClient(ctx, llmClient);

  let resolved = false;
  // Gates late-reconcile so config:switch-model doesn't misroute under a non-ash backend.
  let ashActive = false;
  let agentLoop: AgentLoop | null = null;
  let loadedExtensionNames: string[] = [];

  bus.on("agent:providers:changed", () => {
    refreshSettingsProviders();
    resolvedProviders = computeResolvedProviders();
    if (!resolved) return;
    bus.emit("agent:models-changed", {});
    if (!ashActive) return;
    if (buildModels().some((m) => m.id === llmClient.model)) return;
    const pendingProvider = settingsService.get().defaultProvider;
    if (!pendingProvider) return;
    const p = resolvedProviders.get(pendingProvider);
    if (!p) return;
    const pendingModel = persistedModelFor(pendingProvider);
    if (pendingModel && p.models.includes(pendingModel) && llmClient.model !== pendingModel) {
      bus.emit("config:switch-model", { id: pendingModel, provider: pendingProvider });
    }
  });

  bus.on("provider:configure", ({ id, reasoningParams, cacheTokens, requestHeaders }) => {
    const prev = providerHooks.get(id) ?? {};
    if (reasoningParams !== undefined) prev.reasoningParams = reasoningParams;
    if (cacheTokens !== undefined) prev.cacheTokens = cacheTokens;
    if (requestHeaders !== undefined) prev.requestHeaders = requestHeaders;
    providerHooks.set(id, prev);
  });

  bus.on("core:extensions-loaded", ({ names }) => {
    loadedExtensionNames = names;
    resolvedProviders = computeResolvedProviders();

    const settings = settingsService.get();

    let providerName: string | undefined = config.provider ?? settings.defaultProvider;
    let activeProvider = providerName ? resolvedProviders.get(providerName) ?? null : null;

    // Inline CLI credentials carry their own endpoint, so they skip the
    // usable-provider fallback that registry-driven selection needs.
    if (!config.apiKey) {
      if (!providerName) {
        const first = [...resolvedProviders].find(([, p]) => usableProvider(p));
        providerName = first?.[0];
        activeProvider = first?.[1] ?? null;
      } else if (!usableProvider(activeProvider)) {
        const reason = !activeProvider ? "is not registered"
          : !activeProvider.apiKey ? "has no API key configured"
          : "has no endpoint configured";
        const next = [...resolvedProviders].find(([, p]) => usableProvider(p));
        if (next) {
          bus.emit("ui:error", { message: `Provider "${providerName}" ${reason}; falling back to "${next[0]}".` });
          providerName = next[0];
          activeProvider = next[1];
        } else {
          bus.emit("ui:error", { message: `Provider "${providerName}" ${reason}, and no other configured provider has both an API key and an endpoint. Run \`agent-sh auth\` to configure one.` });
          return;
        }
      }
    }

    // Persisted defaultModel wins over openrouter's hardcoded DEFAULT_MODELS[0].
    const effectiveApiKey = config.apiKey ?? activeProvider?.apiKey;
    const effectiveBaseURL = config.baseURL ?? activeProvider?.baseURL;
    const effectiveModel = config.model ?? persistedModelFor(providerName) ?? activeProvider?.defaultModel;

    // No provider → don't register ash; let another backend own activation.
    if (!effectiveApiKey || !effectiveModel) return;

    const foundModel = buildModels().find(
      (m) => m.id === effectiveModel && (!activeProvider || m.provider === activeProvider.id),
    );
    // Stub when openrouter's async catalog hasn't returned yet; reconciled
    // later via agent:providers:changed → config:switch-model.
    const initialModel: Model = foundModel ?? {
      id: effectiveModel,
      provider: activeProvider?.id ?? providerName ?? "custom",
      supportsReasoningEffort: activeProvider?.supportsReasoningEffort,
    };

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
          handlers: { define: ctx.define, advise: ctx.advise, call: ctx.call, list: ctx.list, hasBase: ctx.hasBase },
          initialModel,
          compositor: ctx.shell?.compositor,
          instanceId: ctx.instanceId,
        });
        agentLoop.wire();
        ashActive = true;
        bus.emit("command:register", {
          name: "/compact",
          description: "Compact now, or: off | on | threshold <0..1> | status",
          handler: (args: string) => {
            const trimmed = args.trim();
            if (!trimmed) {
              bus.emit("agent:compact-request", {});
              return;
            }
            const [sub, ...rest] = trimmed.split(/\s+/);
            if (sub === "off" || sub === "on") {
              settingsService.setSessionOverlay({ autoCompact: sub === "on" });
              bus.emit("ui:info", { message: `auto-compact: ${sub} (session)` });
              return;
            }
            if (sub === "threshold") {
              const raw = rest[0];
              const n = Number(raw);
              if (!raw || !Number.isFinite(n) || n < 0 || n > 1) {
                bus.emit("ui:error", { message: "usage: /compact threshold <0.0..1.0>" });
                return;
              }
              settingsService.setSessionOverlay({ autoCompactThreshold: n });
              bus.emit("ui:info", { message: `auto-compact threshold: ${n} (session)` });
              return;
            }
            if (sub === "reset") {
              settingsService.clearSessionOverlay("autoCompact", "autoCompactThreshold");
              bus.emit("ui:info", { message: "auto-compact: session overrides cleared" });
              return;
            }
            if (sub === "status") {
              const s = settingsService.get();
              const enabledSrc = settingsService.getSettingSource("autoCompact");
              const thSrc = settingsService.getSettingSource("autoCompactThreshold");
              bus.emit("ui:info", {
                message:
                  `auto-compact: ${s.autoCompact ? "on" : "off"} (${enabledSrc}), ` +
                  `threshold: ${s.autoCompactThreshold} (${thSrc})`,
              });
              return;
            }
            bus.emit("ui:error", {
              message: `unknown subcommand: ${sub}. usage: /compact [off|on|threshold <0..1>|reset|status]`,
            });
          },
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
    if (!p.baseURL && p.id !== "openai") {
      bus.emit("ui:error", { message: `Provider "${name}" has no endpoint configured` });
      return;
    }
    const switchModel = p.defaultModel ?? p.models[0];
    if (!switchModel) {
      bus.emit("ui:error", { message: `Provider "${name}" has no models configured` });
      return;
    }
    llmClient.reconfigure({ apiKey: p.apiKey, baseURL: p.baseURL, model: switchModel });
    bus.emit("agent:models-changed", {});
    bus.emit("config:switch-model", { id: switchModel, provider: name });
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
export { runSubagent, type SubagentOptions, type SubagentMessage } from "./subagent.js";

/** Built-in providers register unconditionally so `auth list` can
 *  enumerate them; buildModels() skips entries without an apiKey. */
export function activateAgent(ctx: ExtensionContext): void {
  agentBackend(ctx);
  const agentCtx = ctx as AgentContext;
  activateOpenrouter(agentCtx);
  activateOpenai(agentCtx);
  if (process.env.OPENAI_BASE_URL) activateOpenaiCompatible(agentCtx);
  activateDeepseek(agentCtx);
  activateOllama(agentCtx);
  activateZaiCodingPlan(agentCtx);
  activateOpencode(agentCtx);
}
