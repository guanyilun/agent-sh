/** Subprocess driver for tests/agent/provider-refresh.test.ts. Reports the
 *  apiKey agent:resolve-endpoint returns before a settings edit, after the edit
 *  (with reloadSettings + agent:providers:changed), and after the provider is
 *  removed from settings. */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createCore } from "../../src/core/index.js";
import { activateAgent } from "../../src/agent/index.js";
import { reloadSettings } from "../../src/core/settings.js";
import type { AppConfig } from "../../src/shell/host-types.js";

function settings(providers: Record<string, unknown>) {
  return JSON.stringify({ defaultProvider: "myproxy", providers });
}

async function main() {
  const settingsPath = join(process.env.AGENT_SH_HOME!, "settings.json");

  const core = createCore({} as AppConfig);
  const ctx = core.extensionContext({ quit: () => {} });
  activateAgent(ctx);
  core.bus.emit("core:extensions-loaded", { names: [] });
  await new Promise((r) => setImmediate(r));

  const key = () =>
    (ctx.call("agent:resolve-endpoint", { provider: "myproxy", id: "m1" }) as { apiKey?: string } | undefined)?.apiKey;

  const reload = (providers: Record<string, unknown>) => {
    writeFileSync(settingsPath, settings(providers));
    reloadSettings();
    core.bus.emit("agent:providers:changed", {});
  };

  const before = key();
  reload({ myproxy: { apiKey: "sk-new", baseURL: "https://proxy.local/v1", defaultModel: "m1" } });
  const afterEdit = key();
  reload({});
  const afterRemove = key();

  process.stdout.write(JSON.stringify({ before, afterEdit, afterRemove }) + "\n");
  process.exit(0);
}

main().catch((err) => {
  console.error("driver error:", err);
  process.exit(1);
});

process.on("unhandledRejection", () => {});
