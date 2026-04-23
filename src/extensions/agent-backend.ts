/**
 * Built-in agent backend extension.
 *
 * Constructs the AgentLoop synchronously with a placeholder LlmClient,
 * so core handlers (history:append, system-prompt:build, conversation:*)
 * are defined before user extensions activate. Mode resolution is
 * deferred to `core:extensions-loaded`, giving runtime-registered
 * providers (e.g. openrouter) a chance to register before we look up
 * settings.defaultProvider. Without this deferral, a persisted
 * `defaultProvider: "openrouter"` loses to a cold-start race and the
 * backend bails silently.
 */
import type { ExtensionContext } from "../types.js";
import type { AgentMode, AgentShellConfig } from "../types.js";
import { AgentLoop } from "../agent/agent-loop.js";
import { LlmClient } from "../utils/llm-client.js";
import { resolveProvider, getProviderNames, getSettings, type ResolvedProvider } from "../settings.js";
import { PACKAGE_VERSION } from "../utils/package-version.js";

/** Read the user's persisted defaultModel for a provider, if any. */
function persistedModelFor(providerName: string | undefined): string | undefined {
  if (!providerName) return undefined;
  return getSettings().providers?.[providerName]?.defaultModel;
}

export default function agentBackend(ctx: ExtensionContext): void {
  const { bus } = ctx;
  const config: AgentShellConfig = ctx.call("config:get-shell-config") ?? {};

  // Seed from settings.json; runtime provider:register events add more.
  const providerRegistry = new Map<string, ResolvedProvider>();
  for (const name of getProviderNames()) {
    const p = resolveProvider(name);
    if (p) providerRegistry.set(name, p);
  }

  const buildModes = (): AgentMode[] => {
    const allModes: AgentMode[] = [];
    for (const [id, p] of providerRegistry) {
      if (!p.apiKey) continue;
      for (const model of p.models) {
        const mc = p.modelCapabilities?.get(model);
        allModes.push({
          model,
          provider: id,
          providerConfig: { apiKey: p.apiKey, baseURL: p.baseURL },
          contextWindow: mc?.contextWindow ?? p.contextWindow,
          reasoning: mc?.reasoning,
          supportsReasoningEffort: p.supportsReasoningEffort,
        });
      }
    }
    return allModes;
  };

  // Placeholder client — reconfigured at core:extensions-loaded. Any
  // stream() call before then fails from the OpenAI SDK; start() won't
  // wire the loop until we've resolved, so users never hit that path.
  const llmClient = new LlmClient({ apiKey: "not-configured", model: "not-configured" });
  ctx.define("llm:get-client", () => llmClient);
  ctx.define("llm:invoke", (messages: { role: string; content: string }[], opts?: { maxTokens?: number }) => {
    return llmClient.complete({
      messages: messages as Parameters<typeof llmClient.complete>[0]["messages"],
      max_tokens: opts?.maxTokens,
    });
  });

  let modes: AgentMode[] = [];
  let initialModeIndex = 0;
  let resolved = false;

  bus.onPipe("config:get-initial-modes", () => ({ modes, initialModeIndex }));

  // AgentLoop must be constructed *before* user extensions activate,
  // because its ctor defines handlers (history:append, etc.) that
  // extensions like superash call synchronously during their own
  // activate. Advise-before-define works for advisers, but plain calls
  // would hit a no-op stub.
  const agentLoop = new AgentLoop({
    bus,
    contextManager: ctx.contextManager,
    llmClient,
    handlers: { define: ctx.define, advise: ctx.advise, call: ctx.call, list: ctx.list },
    modes,
    initialModeIndex,
    compositor: ctx.compositor,
    instanceId: ctx.instanceId,
  });

  bus.on("core:extensions-loaded", () => {
    const settings = getSettings();
    // If the user didn't pick a default, fall back to the first registered
    // provider (built-in load order biases to openrouter → openai).
    const providerName = config.provider ?? settings.defaultProvider
      ?? (providerRegistry.size > 0 ? providerRegistry.keys().next().value : undefined);
    const activeProvider = providerName ? providerRegistry.get(providerName) ?? null : null;

    // User's persisted defaultModel wins over the provider's declared
    // default. Dynamic providers (openrouter) re-register with their
    // hardcoded DEFAULT_MODELS[0] each startup, which would otherwise
    // clobber the user's /model selection.
    const effectiveApiKey = config.apiKey ?? activeProvider?.apiKey;
    const effectiveBaseURL = config.baseURL ?? activeProvider?.baseURL;
    const effectiveModel = config.model ?? persistedModelFor(providerName) ?? activeProvider?.defaultModel;

    // No provider → don't register ash at all, so another backend (e.g.
    // claude-code-bridge) can own activation. index.ts hard-fails only
    // when no backend ended up registered.
    if (!effectiveApiKey || !effectiveModel) return;

    modes = buildModes();
    if (modes.length === 0) modes = [{ model: effectiveModel }];
    let foundIdx = modes.findIndex(
      (m) => m.model === effectiveModel && (!activeProvider || m.provider === activeProvider.id),
    );
    // Persisted default may not be in the provider's curated list yet (e.g.
    // openrouter's async catalog fetch hasn't returned). Prepend a stub so
    // the initial config:set-modes activeIndex points at the real model —
    // otherwise AgentLoop reconfigures llmClient back to modes[0].
    if (foundIdx === -1 && activeProvider) {
      modes = [
        {
          model: effectiveModel,
          provider: activeProvider.id,
          providerConfig: { apiKey: effectiveApiKey, baseURL: effectiveBaseURL },
          supportsReasoningEffort: activeProvider.supportsReasoningEffort,
        },
        ...modes,
      ];
      foundIdx = 0;
    }
    initialModeIndex = Math.max(0, foundIdx);

    llmClient.reconfigure({ apiKey: effectiveApiKey, baseURL: effectiveBaseURL, model: effectiveModel });
    bus.emit("config:set-modes", { modes, activeIndex: initialModeIndex });
    resolved = true;

    bus.emit("agent:register-backend", {
      name: "ash",
      kill: () => agentLoop.kill(),
      start: async () => {
        agentLoop.wire();
        bus.emit("agent:info", {
          name: "ash",
          version: PACKAGE_VERSION,
          model: llmClient.model,
          provider: modes[initialModeIndex]?.provider,
          contextWindow: modes[initialModeIndex]?.contextWindow,
        });
      },
    });
  });

  bus.on("provider:register", (p) => {
    const rawModels = p.models ?? (p.defaultModel ? [p.defaultModel] : []);
    const modelIds: string[] = [];
    const caps = new Map<string, { reasoning?: boolean; contextWindow?: number }>();
    for (const m of rawModels) {
      if (typeof m === "string") {
        modelIds.push(m);
      } else {
        modelIds.push(m.id);
        caps.set(m.id, { reasoning: m.reasoning, contextWindow: m.contextWindow });
      }
    }
    providerRegistry.set(p.id, {
      id: p.id,
      apiKey: p.apiKey,
      baseURL: p.baseURL,
      defaultModel: p.defaultModel,
      models: modelIds,
      supportsReasoningEffort: p.supportsReasoningEffort,
      modelCapabilities: caps.size > 0 ? caps : undefined,
    });

    const addModes: AgentMode[] = modelIds.map((m) => {
      const mc = caps.get(m);
      return {
        model: m,
        provider: p.id,
        providerConfig: { apiKey: p.apiKey ?? "", baseURL: p.baseURL },
        contextWindow: mc?.contextWindow,
        reasoning: mc?.reasoning,
        supportsReasoningEffort: p.supportsReasoningEffort,
      };
    });
    bus.emit("config:add-modes", { modes: addModes });

    // Late-registration reconcile: if this completes the user's persisted
    // default (openrouter's async fetch delivers the full catalog after
    // we've already fallen back to mode 0), quietly switch to it.
    if (!resolved) return;
    const pendingProvider = getSettings().defaultProvider;
    if (pendingProvider !== p.id) return;
    const pendingModel = persistedModelFor(pendingProvider);
    if (pendingModel && modelIds.includes(pendingModel) && llmClient.model !== pendingModel) {
      bus.emit("config:switch-model", { model: pendingModel });
    }
  });

  bus.on("config:switch-provider", ({ provider: name }) => {
    const p = providerRegistry.get(name);
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

    const newModes: AgentMode[] = p.models.map((m) => {
      const mc = p.modelCapabilities?.get(m);
      return {
        model: m,
        provider: name,
        providerConfig: { apiKey: p.apiKey!, baseURL: p.baseURL },
        contextWindow: mc?.contextWindow ?? p.contextWindow,
        reasoning: mc?.reasoning,
        supportsReasoningEffort: p.supportsReasoningEffort,
      };
    });
    bus.emit("config:set-modes", { modes: newModes });

    bus.emit("agent:info", { name: "ash", version: PACKAGE_VERSION, model: switchModel, provider: name, contextWindow: p.contextWindow });
    bus.emit("ui:info", { message: `Switched to ${name} (${switchModel})` });
    bus.emit("config:changed", {});
  });
}
