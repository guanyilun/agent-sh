/**
 * Bootstrap a throwaway core to enumerate provider IDs that built-in
 * + user-installed extensions would register. Lets `agent-sh auth list`
 * and `auth login` show ids the user hasn't keyed yet, without a
 * hardcoded list.
 *
 * Extension `activate()` functions run; provider extensions register
 * unconditionally now and gate their HTTP catalog fetches on apiKey
 * presence, so this stays cheap (a few module imports, no network).
 */
import { createCore } from "../../core/index.js";
import activateAgentBackend from "../../extensions/agent-backend/index.js";
import { activateAgent } from "../../agent/index.js";
import { loadExtensions } from "../../core/extension-loader.js";
import { loadBuiltinExtensions } from "../../extensions/index.js";
import { getSettings } from "../../core/settings.js";
import type { AppConfig } from "../../shell/host-types.js";
import type { ProviderRegistration } from "../../agent/host-types.js";

let cached: string[] | null = null;

/** Returns provider IDs contributed via `ctx.agent.providers.register`,
 *  including built-ins and user-installed extensions. Cached per process. */
export async function discoverExtensionProviders(): Promise<string[]> {
  if (cached) return cached;
  const core = createCore({} as AppConfig);
  try {
    const ctx = core.extensionContext({ quit: () => {} });
    activateAgentBackend(ctx);
    activateAgent(ctx);
    await loadBuiltinExtensions(ctx, getSettings().disabledBuiltins);
    await loadExtensions(ctx).catch(() => { /* user-installed failures non-fatal */ });
    const { providers } = core.bus.emitPipe("agent:providers", { providers: [] as ProviderRegistration[] });
    cached = providers.map((p) => p.id);
    return cached;
  } finally {
    core.kill();
  }
}
