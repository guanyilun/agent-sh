/**
 * Cross-cutting built-ins, toggleable via `disabledBuiltins`.
 * Module-owned built-ins activate inline:
 *   shell-context, tui-renderer → registerShellHandlers (src/shell/)
 *   ash (a specific backend)    → activateAgent         (src/agent/)
 *   backend registry             → createCore           (src/core/)
 */
import type { ExtensionContext } from "../shell/host-types.js";

type ActivateFn = (ctx: ExtensionContext) => void;

export const BUILTIN_EXTENSIONS: Array<{
  name: string;
  load: () => Promise<ActivateFn>;
}> = [
  { name: "slash-commands",    load: () => import("./slash-commands/index.js").then(m => m.default) },
  { name: "file-autocomplete", load: () => import("./file-autocomplete.js").then(m => m.default) },
];

/**
 * Load built-in extensions sequentially, skipping any in the disabled list.
 * Returns the names of extensions that were loaded.
 */
export async function loadBuiltinExtensions(
  ctx: ExtensionContext,
  disabled: string[] = [],
): Promise<string[]> {
  const disabledSet = new Set(disabled);
  const loaded: string[] = [];
  for (const ext of BUILTIN_EXTENSIONS) {
    if (disabledSet.has(ext.name)) continue;
    const activate = await ext.load();
    activate(ctx);
    loaded.push(ext.name);
  }
  return loaded;
}
