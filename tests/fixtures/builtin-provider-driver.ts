/** Subprocess driver for tests/agent/builtin-provider-activation.test.ts.
 *  Runs activateAgent (which calls every built-in provider activator),
 *  fires core:extensions-loaded, then dumps the registered provider ids
 *  and any agent:register-backend events that fired. */
import { createCore } from "../../src/core/index.js";
import { activateAgent } from "../../src/agent/index.js";
import type { AppConfig } from "../../src/shell/host-types.js";
import type { ProviderRegistration } from "../../src/agent/host-types.js";

async function main() {
  const core = createCore({} as AppConfig);
  const backendRegistrations: Array<{ name: string }> = [];

  core.bus.on("agent:register-backend" as never, (payload: { name: string }) => {
    backendRegistrations.push({ name: payload.name });
  });

  const ctx = core.extensionContext({ quit: () => {} });
  activateAgent(ctx);

  core.bus.emit("core:extensions-loaded", { names: [] });
  await new Promise((r) => setImmediate(r));

  const { providers } = core.bus.emitPipe("agent:providers", {
    providers: [] as ProviderRegistration[],
  });
  const registeredIds = providers.map((p) => p.id).sort();

  process.stdout.write(JSON.stringify({ registeredIds, backendRegistrations }) + "\n");
  process.exit(0);
}

main().catch((err) => {
  console.error("driver error:", err);
  process.exit(1);
});

// Silence unhandled rejections from openrouter's background fetchModels —
// the driver exits before the in-flight network call lands.
process.on("unhandledRejection", () => {});
