import type { AgentShellCore, ExtensionContext } from "../core/index.js";
import { loadBuiltinExtensions } from "../extensions/index.js";
import { loadExtensions } from "../core/extension-loader.js";
import { getSettings } from "../core/settings.js";
import { suggestBridgeFor } from "./install.js";

const LOAD_EXTENSIONS_TIMEOUT_MS = 10000;

export async function loadAllExtensions(extCtx: ExtensionContext, extensions: string[] | undefined): Promise<void> {
  await loadBuiltinExtensions(extCtx, getSettings().disabledBuiltins);
  let loaded: string[] = [];
  await Promise.race([
    loadExtensions(extCtx, extensions).then((names) => { loaded = names; }),
    new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error(`Extension loading timeout after ${LOAD_EXTENSIONS_TIMEOUT_MS}ms`)), LOAD_EXTENSIONS_TIMEOUT_MS)
    ),
  ]).catch((err) => {
    console.error(`Warning: ${err.message}`);
  });
  extCtx.bus.emit("core:extensions-loaded", { names: loaded });
}

export function requireBackends(core: AgentShellCore, backend: string | undefined): string[] {
  const { names } = core.bus.emitPipe("config:get-backends", { names: [] as string[], active: null as string | null });
  if (names.length === 0) {
    console.error("\nagent-sh: no agent backend available.\n\n" +
      "  Export OPENROUTER_API_KEY or OPENAI_API_KEY for zero-config launch, or\n" +
      "  pass --api-key on the command line, or\n" +
      "  run `agent-sh init` for a settings.json template, or\n" +
      "  run `agent-sh install <bridge>` (e.g. pi-bridge, claude-code-bridge) to use a non-ash backend.\n");
    process.exit(1);
  }
  if (backend && !names.includes(backend)) {
    const bridge = suggestBridgeFor(backend);
    const hint = bridge
      ? `  Try: agent-sh install ${bridge}\n`
      : `  Run \`agent-sh install\` to see bundled bridge extensions.\n`;
    console.error(`\nagent-sh: backend "${backend}" is not available.\n\n` +
      `  Available backends: ${names.join(", ")}\n` +
      hint);
    process.exit(1);
  }
  return names;
}
