/** Bootstrap a throwaway core to enumerate provider ids extensions
 *  would register, so `auth list` shows ids the user hasn't keyed yet. */
import * as path from "node:path";
import { createCore } from "../../core/index.js";
import { activateAgent } from "../../agent/index.js";
import { loadExtensions } from "../../core/extension-loader.js";
import { loadBuiltinExtensions } from "../../extensions/index.js";
import { CONFIG_DIR, getSettings } from "../../core/settings.js";
import type { AppConfig } from "../../shell/host-types.js";
import type { ProviderRegistration } from "../../agent/host-types.js";

const EXT_DIR = path.join(CONFIG_DIR, "extensions");
const BARE_IMPORT_RE = /Cannot find (?:package|module) ['"]agent-sh\/[^'"]+['"]/;

export interface DiscoveredProvider {
  id: string;
  noAuth?: boolean;
}

let cached: DiscoveredProvider[] | null = null;

export async function discoverExtensionProviders(): Promise<DiscoveredProvider[]> {
  if (cached) return cached;
  const core = createCore({} as AppConfig);
  const errors: string[] = [];
  core.bus.on("ui:error", ({ message }) => { errors.push(message); });
  try {
    const ctx = core.extensionContext({ quit: () => {} });
    activateAgent(ctx);
    await loadBuiltinExtensions(ctx, getSettings().disabledBuiltins);
    await loadExtensions(ctx).catch(() => {});
    const { providers } = core.bus.emitPipe("agent:providers", { providers: [] as ProviderRegistration[] });
    cached = providers.map((p) => ({ id: p.id, noAuth: p.noAuth }));
    if (errors.length > 0) {
      process.stderr.write(`\n[agent-sh] extension load errors during provider discovery:\n`);
      for (const msg of errors) {
        process.stderr.write(`  - ${msg}\n`);
        if (BARE_IMPORT_RE.test(msg) && msg.includes(EXT_DIR)) {
          process.stderr.write(
            `      ↳ Single-file extensions can't runtime-import agent-sh modules from ${EXT_DIR}.\n` +
            `        Use ctx.call(...) for runtime needs, or convert to a directory extension\n` +
            `        with its own package.json + node_modules.\n`,
          );
        }
      }
      process.stderr.write(`\n`);
    }
    return cached;
  } finally {
    core.kill();
  }
}
