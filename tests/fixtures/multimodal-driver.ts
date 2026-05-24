/** Subprocess driver for multimodal integration tests.
 *  Registers a provider, activates ash, captures the system prompt. */
import { createCore } from "../../src/core/index.js";
import agentBackend from "../../src/agent/index.js";
import type { AppConfig, ExtensionContext } from "../../src/shell/host-types.js";
import type { AgentSurface, ProviderRegistration } from "../../src/agent/host-types.js";

interface Scenario {
  provider: ProviderRegistration;
}

async function main() {
  const raw = process.argv[2];
  if (!raw) {
    console.error("driver: missing scenario JSON");
    process.exit(2);
  }
  const scenario = JSON.parse(raw) as Scenario;

  const core = createCore({} as AppConfig);
  const captured: Array<{ event: string; payload: unknown }> = [];
  core.bus.on("agent:info" as never, (payload: unknown) => {
    captured.push({ event: "agent:info", payload });
  });

  const ctx = core.extensionContext({ quit: () => {} });
  agentBackend(ctx);
  const agent = (ctx as ExtensionContext & { agent: AgentSurface }).agent;

  agent.providers.register(scenario.provider);
  core.bus.emit("core:extensions-loaded", { names: [] });
  await core.activateBackend("ash");

  await new Promise((r) => setImmediate(r));

  const systemPrompt = ctx.call("system-prompt:build") as string;

  process.stdout.write(JSON.stringify({ events: captured, systemPrompt }) + "\n");
  process.exit(0);
}

main().catch((err) => {
  console.error("driver error:", err);
  process.exit(1);
});
