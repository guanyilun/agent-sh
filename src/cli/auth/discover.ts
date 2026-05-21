/** Bootstrap a throwaway core to enumerate provider ids extensions
 *  would register, so `auth list` shows ids the user hasn't keyed yet. */
import { createCore } from "../../core/index.js";
import activateAgentBackend from "../../extensions/agent-backend/index.js";
import { activateAgent } from "../../agent/index.js";
import { loadExtensions } from "../../core/extension-loader.js";
import { loadBuiltinExtensions } from "../../extensions/index.js";
import { getSettings } from "../../core/settings.js";
import type { AppConfig } from "../../shell/host-types.js";
import type { ProviderRegistration } from "../../agent/host-types.js";

export interface DiscoveredProvider {
  id: string;
  noAuth?: boolean;
}

let cached: DiscoveredProvider[] | null = null;

export async function discoverExtensionProviders(): Promise<DiscoveredProvider[]> {
  if (cached) return cached;
  const core = createCore({} as AppConfig);
  try {
    const ctx = core.extensionContext({ quit: () => {} });
    activateAgentBackend(ctx);
    activateAgent(ctx);
    await loadBuiltinExtensions(ctx, getSettings().disabledBuiltins);
    await loadExtensions(ctx).catch(() => {});
    const { providers } = core.bus.emitPipe("agent:providers", { providers: [] as ProviderRegistration[] });
    cached = providers.map((p) => ({ id: p.id, noAuth: p.noAuth }));
    return cached;
  } finally {
    core.kill();
  }
}
