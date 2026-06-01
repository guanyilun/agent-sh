/** Subprocess driver for provider/mode integration tests.
 *  Reads scenario JSON from argv[2], prints captured events as JSON. */
import { createCore } from "../../src/core/index.js";
import agentBackend from "../../src/agent/index.js";
import type { AppConfig, ExtensionContext } from "../../src/shell/host-types.js";
import type { Model, ModelEndpoint, AgentSurface, ProviderRegistration } from "../../src/agent/host-types.js";

interface Scenario {
  config?: Partial<AppConfig>;
  capture: string[];
  dumpModels?: boolean;
  probeCacheTokens?: Array<{ model: string; usage: Record<string, unknown> }>;
  steps: Array<
    | { kind: "providers.register"; payload: ProviderRegistration }
    | { kind: "providers.unregister"; id: string }
    | { kind: "activate-provider"; name: keyof typeof PROVIDER_MODULES }
    | { kind: "core:extensions-loaded"; names?: string[] }
    | { kind: "activate-backend"; name: string }
    | { kind: "wait" }
  >;
}

const PROVIDER_MODULES = {
  deepseek: () => import("../../src/agent/providers/deepseek.js"),
  openrouter: () => import("../../src/agent/providers/openrouter.js"),
  openai: () => import("../../src/agent/providers/openai.js"),
} as const;

async function main() {
  const raw = process.argv[2];
  if (!raw) {
    console.error("driver: missing scenario JSON");
    process.exit(2);
  }
  const scenario = JSON.parse(raw) as Scenario;

  const core = createCore((scenario.config ?? {}) as AppConfig);
  const captured: Array<{ event: string; payload: unknown }> = [];

  for (const ev of scenario.capture) {
    core.bus.on(ev as never, (payload: unknown) => {
      captured.push({ event: ev, payload: stripFns(payload) });
    });
  }

  const ctx = core.extensionContext({ quit: () => {} });
  agentBackend(ctx);
  const agent = (ctx as ExtensionContext & { agent: AgentSurface }).agent;

  for (const step of scenario.steps) {
    if (step.kind === "providers.register") {
      agent.providers.register(step.payload);
    } else if (step.kind === "providers.unregister") {
      agent.providers.unregister(step.id);
    } else if (step.kind === "activate-provider") {
      const mod = await PROVIDER_MODULES[step.name]();
      mod.default(ctx as ExtensionContext & { agent: AgentSurface });
    } else if (step.kind === "core:extensions-loaded") {
      core.bus.emit("core:extensions-loaded", { names: step.names ?? [] });
    } else if (step.kind === "activate-backend") {
      await core.activateBackend(step.name);
    } else if (step.kind === "wait") {
      await new Promise((r) => setImmediate(r));
    }
  }

  await new Promise((r) => setImmediate(r));
  const endpointFor = (m: Model): ModelEndpoint | undefined => {
    try {
      return ctx.call("agent:resolve-endpoint", { provider: m.provider, id: m.id }) as ModelEndpoint | undefined;
    } catch {
      return undefined;
    }
  };

  let models: Model[] | undefined;
  if (scenario.dumpModels || scenario.probeCacheTokens) {
    try {
      models = ctx.call("agent:get-models") as Model[];
    } catch {
      models = undefined;
    }
  }

  let cacheProbes: Array<{ model: string; result: number | undefined; found: boolean }> | undefined;
  if (scenario.probeCacheTokens) {
    cacheProbes = scenario.probeCacheTokens.map(({ model, usage }) => {
      const m = models?.find((x) => x.id === model);
      const ep = m ? endpointFor(m) : undefined;
      return { model, found: !!m, result: ep?.extractCachedTokens?.(usage) };
    });
  }

  const dumped = models?.map((m) => ({ ...m, endpoint: endpointFor(m) }));

  process.stdout.write(JSON.stringify({
    events: captured,
    models: scenario.dumpModels ? stripFns(dumped) : undefined,
    cacheProbes,
  }) + "\n");
  process.exit(0);
}

function stripFns(v: unknown): unknown {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(stripFns);
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v)) {
    if (typeof val === "function") continue;
    if (val instanceof Map) {
      out[k] = Object.fromEntries([...val.entries()].map(([mk, mv]) => [mk, stripFns(mv)]));
    } else {
      out[k] = stripFns(val);
    }
  }
  return out;
}

main().catch((err) => {
  console.error("driver error:", err);
  process.exit(1);
});
