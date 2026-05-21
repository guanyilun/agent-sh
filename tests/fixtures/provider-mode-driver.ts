/**
 * Subprocess driver for provider/mode integration tests.
 *
 * Reads a scenario JSON from argv[2], wires core + agent-backend + ash,
 * captures bus events listed in `capture`, runs scripted `steps`, then
 * prints `{ events: [...] }` to stdout for the parent test to assert on.
 *
 * AGENT_SH_HOME is set by the parent so getSettings() loads from a
 * per-test settings.json — each subprocess gets its own module realm.
 */
import { createCore } from "../../src/core/index.js";
import activateAgentBackend from "../../src/extensions/agent-backend/index.js";
import agentBackend from "../../src/agent/index.js";
import type { AppConfig, ExtensionContext } from "../../src/shell/host-types.js";
import type { AgentMode, AgentSurface, ProviderRegistration } from "../../src/agent/host-types.js";

interface Scenario {
  config?: Partial<AppConfig>;
  capture: string[];
  /** After all steps run and bus settles, dump the current
   *  `agent:get-modes` result under this key in the output. */
  dumpModes?: boolean;
  steps: Array<
    | { kind: "providers.register"; payload: ProviderRegistration }
    | { kind: "providers.unregister"; id: string }
    | { kind: "core:extensions-loaded"; names?: string[] }
    | { kind: "activate-backend"; name: string }
    | { kind: "wait" }
  >;
}

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
  activateAgentBackend(ctx);
  agentBackend(ctx);
  const agent = (ctx as ExtensionContext & { agent: AgentSurface }).agent;

  for (const step of scenario.steps) {
    if (step.kind === "providers.register") {
      agent.providers.register(step.payload);
    } else if (step.kind === "providers.unregister") {
      agent.providers.unregister(step.id);
    } else if (step.kind === "core:extensions-loaded") {
      core.bus.emit("core:extensions-loaded", { names: step.names ?? [] });
    } else if (step.kind === "activate-backend") {
      await core.activateBackend(step.name);
    } else if (step.kind === "wait") {
      await new Promise((r) => setImmediate(r));
    }
  }

  await new Promise((r) => setImmediate(r));
  let modes: AgentMode[] | undefined;
  if (scenario.dumpModes) {
    try {
      modes = ctx.call("agent:get-modes") as AgentMode[];
    } catch {
      modes = undefined;
    }
  }
  process.stdout.write(JSON.stringify({ events: captured, modes: stripFns(modes) }) + "\n");
  process.exit(0);
}

/** Strip non-JSON-serializable members (functions, bigints) so payloads
 *  with `buildReasoningParams` and `handler` round-trip cleanly. */
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
