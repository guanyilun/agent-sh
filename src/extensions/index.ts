/**
 * Built-in extension manifest.
 *
 * These extensions ship with agent-sh and load before user extensions.
 * They receive unscoped contexts (not reloadable) and can be individually
 * disabled via the `disabledBuiltins` setting in ~/.agent-sh/settings.json.
 *
 * For order-critical frontend bootstrap (the PTY shell), see `src/shell/`.
 * That module exposes its own `activate(ctx, opts)` entry point, loaded
 * specially from `src/index.ts` rather than through this manifest.
 */
import type { ExtensionContext } from "../core/types.js";
import { resolveApiKey } from "../cli/auth/keys.js";

type ActivateFn = (ctx: ExtensionContext) => void;

export const BUILTIN_EXTENSIONS: Array<{
  name: string;
  // When present and false, the module isn't imported — keeps provider
  // built-ins dormant unless a key is configured.
  when?: () => boolean;
  load: () => Promise<ActivateFn>;
}> = [
  { name: "shell-context",   load: () => import("../shell/shell-context.js").then(m => m.default) },
  { name: "agent-backend",    load: () => import("../agent/index.js").then(m => m.default) },
  { name: "openrouter",
    when: () => !!resolveApiKey("openrouter").key,
    load: () => import("../agent/providers/openrouter.js").then(m => m.default) },
  { name: "openai",
    when: () => !!resolveApiKey("openai").key && !process.env.OPENAI_BASE_URL,
    load: () => import("../agent/providers/openai.js").then(m => m.default) },
  { name: "openai-compatible",
    when: () => !!process.env.OPENAI_BASE_URL,
    load: () => import("../agent/providers/openai-compatible.js").then(m => m.default) },
  { name: "deepseek",
    load: () => import("../agent/providers/deepseek.js").then(m => m.default) },
  { name: "tui-renderer",     load: () => import("../shell/tui-renderer.js").then(m => m.default) },
  { name: "slash-commands",    load: () => import("./slash-commands.js").then(m => m.default) },
  { name: "file-autocomplete", load: () => import("../shell/file-autocomplete.js").then(m => m.default) },
];

/**
 * Load built-in extensions sequentially, skipping any in the disabled list
 * or whose `when` predicate returns false. Returns the names of extensions
 * that were loaded.
 */
export async function loadBuiltinExtensions(
  ctx: ExtensionContext,
  disabled: string[] = [],
): Promise<string[]> {
  const disabledSet = new Set(disabled);
  const loaded: string[] = [];
  for (const ext of BUILTIN_EXTENSIONS) {
    if (disabledSet.has(ext.name)) continue;
    if (ext.when && !ext.when()) continue;
    const activate = await ext.load();
    activate(ctx);
    loaded.push(ext.name);
  }
  return loaded;
}
