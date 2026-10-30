import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionContext } from "../shell/host-types.js";
import type { EventBus } from "./event-bus.js";
import { CONFIG_DIR, getSettings } from "./settings.js";

const EXT_DIR = path.join(CONFIG_DIR, "extensions");

const TS_EXTS = [".ts", ".tsx", ".mts"];
const SCRIPT_EXTS = [".js", ".mjs", ".ts", ".tsx", ".mts"];

let tsRegistered = false;
let tsxUnregister: (() => Promise<void>) | null = null;

/**
 * Register tsx's ESM loader for .ts file support.
 *
 * Called before importing .ts extensions. The tsx loader uses Node's
 * module.register() which creates a background thread with a MessageChannel.
 * On reload, the old loader may become stale (the MessageChannel port can be
 * GC'd or the loader thread can stop responding), so we unregister the old
 * handle and re-register on each reload.
 *
 * Initial load: registers fresh.
 * Reload: unregisters old handle, registers new one.
 * Non-reload calls within the same load: no-op (tsRegistered guard).
 */
export async function ensureTsSupport(force = false): Promise<void> {
  if (tsRegistered && !force) return;
  try {
    if (tsxUnregister) {
      try { await tsxUnregister(); } catch { /* ignore stale handle */ }
    }
    const { register } = await import("tsx/esm/api");
    tsxUnregister = register();
    tsRegistered = true;
  } catch {
    // tsx not available — TS extensions will fail with a clear error
  }
}

// ── Scoped context for reloadable extensions ────────────────────

type Cleanup = () => void;
const noop = () => {};

// Void-returning surface registrars have no ownership handle. Coordinate
// scoped writers by raw surface identity, never by extension display name.
// Raw writers still need ownership-aware disposers from the host API.
const surfaceOwners = new WeakMap<object, Map<string, object>>();
const scopeHosts = new WeakMap<ExtensionContext, ExtensionContext>();

/** Surface factories must close over the host lifetime, not an installing scope. */
export function extensionHostContext(ctx: ExtensionContext): ExtensionContext {
  return scopeHosts.get(ctx) ?? ctx;
}

/**
 * Own registrations made by one activation. dispose() starts fault-isolated
 * cleanup synchronously; disposeAsync() awaits reverse-order cleanup and reports
 * failures. Both are idempotent and share pending cleanup work.
 * Host surfaces must be constructed with the raw host context, not this scope:
 * otherwise their closures capture the installing extension's lifetime.
 */
export function createScopedContext(ctx: ExtensionContext, _extensionName: string): { scoped: ExtensionContext; dispose: () => void; disposeAsync: () => Promise<void> } {
  return createScope(ctx, false);
}

// File-loader compatibility: historically synchronous teardown callbacks can
// restore registrations outside the departing extension's ownership. Reusable
// programmable scopes deliberately do not inherit that escape hatch.
function createScope(ctx: ExtensionContext, legacyTeardown: boolean): { scoped: ExtensionContext; dispose: () => void; disposeAsync: () => Promise<void> } {
  const cleanups = new Set<() => Promise<void> | void>();
  const pendingCleanups = new Set<Promise<void>>();
  const errors: unknown[] = [];
  let disposed = false;
  let disposing = false;
  let disposal: Promise<void> | undefined;
  const closed = () => disposed && !(disposing && legacyTeardown);
  const run = (fn: Cleanup): Promise<void> | void => {
    try {
      // onDispose accepts void callbacks, but async callbacks are legal TS.
      // Observe failures immediately, even when only synchronous disposal is used.
      const result = fn() as unknown;
      if (result && typeof (result as PromiseLike<unknown>).then === "function") {
        const pending = Promise.resolve(result).then(() => {}, error => { errors.push(error); });
        pendingCleanups.add(pending);
        void pending.then(() => pendingCleanups.delete(pending));
        return pending;
      }
    } catch (error) { errors.push(error); }
  };
  const track = (fn: Cleanup): Cleanup => {
    let active = true;
    const once = () => {
      if (!active) return;
      active = false;
      cleanups.delete(once);
      return run(fn);
    };
    if (disposing && legacyTeardown) return once;
    if (disposed) once();
    else cleanups.add(once);
    return once;
  };
  const trackUnsub = <A extends unknown[]>(fn: (...args: A) => Cleanup) => (...args: A): Cleanup => {
    if (closed()) return noop;
    return track(fn(...args));
  };
  const own = (surface: object, key: string, register: () => void, remove: Cleanup) => {
    if (closed()) return;
    register();
    let owners = surfaceOwners.get(surface);
    if (!owners) surfaceOwners.set(surface, owners = new Map());
    const token = {};
    owners.set(key, token);
    track(() => {
      if (owners.get(key) !== token) return;
      owners.delete(key);
      remove();
    });
  };
  const forget = (surface: object, key: string, remove: Cleanup) => {
    if (closed()) return;
    surfaceOwners.get(surface)?.delete(key);
    remove();
  };

  const bus = ctx.bus;
  const scopedBus: EventBus = Object.create(bus);
  scopedBus.on = ((event: any, fn: any) => {
    if (closed()) return;
    bus.on(event, fn);
    track(() => bus.off(event, fn));
  }) as typeof bus.on;
  scopedBus.onPipe = ((event: any, fn: any) => {
    if (closed()) return;
    bus.onPipe(event, fn);
    track(() => bus.offPipe(event, fn));
  }) as typeof bus.onPipe;
  scopedBus.onPipeAsync = ((event: any, fn: any) => {
    if (closed()) return;
    bus.onPipeAsync(event, fn);
    track(() => bus.offPipeAsync(event, fn));
  }) as typeof bus.onPipeAsync;
  scopedBus.onAny = trackUnsub((fn) => bus.onAny(fn));

  // Construct wrappers lazily: programmable hosts may attach surfaces after
  // creating scopes. Never publish a scoped wrapper back onto the raw host.
  const agents = new WeakMap<NonNullable<ExtensionContext["agent"]>, NonNullable<ExtensionContext["agent"]>>();
  const wrapAgent = (agent: NonNullable<ExtensionContext["agent"]>) => {
    const cached = agents.get(agent);
    if (cached) return cached;
    const providers = new Map<string, Cleanup>();
    const wrapped: typeof agent = {
      ...agent,
      ...(agent.providers && { providers: {
        ...agent.providers,
        register: (reg) => {
          if (closed()) return noop;
          const previous = providers.get(reg.id);
          // Let the surface replace atomically before releasing the old scope's
          // ownership handle; owned provider disposers are identity-aware.
          const unregister = agent.providers.register(reg);
          previous?.();
          const release = track(() => {
            providers.delete(reg.id);
            unregister();
          });
          if (!closed()) providers.set(reg.id, release);
          return release;
        },
        unregister: (id) => {
          if (closed()) return;
          const release = providers.get(id);
          if (release) release();
          else agent.providers.unregister(id);
        },
      } }),
      registerTool: (tool) => own(agent, `tool:${tool.name}`, () => agent.registerTool(tool), () => agent.unregisterTool(tool.name)),
      unregisterTool: (name) => forget(agent, `tool:${name}`, () => agent.unregisterTool(name)),
      adviseTool: trackUnsub((...args) => agent.adviseTool(...args)),
      adviseToolSchema: trackUnsub((...args) => agent.adviseToolSchema(...args)),
      registerInstruction: (name, text) => own(agent, `instruction:${name}`, () => agent.registerInstruction(name, text), () => agent.removeInstruction(name)),
      removeInstruction: (name) => forget(agent, `instruction:${name}`, () => agent.removeInstruction(name)),
      adviseInstruction: trackUnsub((...args) => agent.adviseInstruction(...args)),
      registerSkill: (name, description, filePath) => own(agent, `skill:${name}`, () => agent.registerSkill(name, description, filePath), () => agent.removeSkill(name)),
      removeSkill: (name) => forget(agent, `skill:${name}`, () => agent.removeSkill(name)),
      adviseSkill: trackUnsub((...args) => agent.adviseSkill(...args)),
      registerContextProducer: trackUnsub((...args) => agent.registerContextProducer(...args)),
    };
    agents.set(agent, wrapped);
    return wrapped;
  };
  const shells = new WeakMap<NonNullable<ExtensionContext["shell"]>, NonNullable<ExtensionContext["shell"]>>();
  const scoped: ExtensionContext = {
    ...ctx,
    bus: scopedBus,
    define: (name, fn) => {
      if (closed()) return;
      // CoreContext's historical void signature remains compatible. Hosts
      // forwarding HandlerRegistry.define's return value opt into ownership.
      const release = ctx.define(name, fn) as unknown;
      if (typeof release === "function") return track(release as Cleanup);
    },
    advise: trackUnsub((...args) => ctx.advise(...args)),
    registerCommand: (name, description, handler) => own(ctx, `command:${name.replace(/^\//, "")}`, () => ctx.registerCommand(name, description, handler), () => bus.emit("command:unregister", { name })),
    adviseCommand: trackUnsub((...args) => ctx.adviseCommand(...args)),
    get agent() { return ctx.agent && wrapAgent(ctx.agent); },
    set agent(value) { ctx.agent = value; },
    get shell() {
      const shell = ctx.shell;
      if (!shell) return undefined;
      let wrapped = shells.get(shell);
      if (!wrapped) {
        wrapped = { ...shell, adviseInputMode: trackUnsub((...args) => shell.adviseInputMode(...args)) };
        shells.set(shell, wrapped);
      }
      return wrapped;
    },
    set shell(value) { ctx.shell = value; },
    onDispose: (fn) => { track(fn); },
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    disposing = true;
    // Reusable scopes release dependants first; keep the loader's historical
    // FIFO teardown (including explicit restoration callbacks) unchanged.
    const pending = [...cleanups];
    for (const fn of legacyTeardown ? pending : pending.reverse()) fn();
    cleanups.clear();
    disposing = false;
  };
  const disposeAsync = (): Promise<void> => {
    if (disposal) return disposal;
    disposed = true;
    // Defer execution so reentrant callers see the same promise before any
    // user cleanup runs (including calls made during synchronous disposal).
    disposal = Promise.resolve().then(async () => {
      const remaining = [...cleanups].reverse();
      for (const fn of remaining) await fn();
      cleanups.clear();
      // Include work already started by dispose(), manual releases, or late
      // onDispose registrations, including registrations made across awaits.
      while (pendingCleanups.size) await Promise.all([...pendingCleanups]);
      if (errors.length) throw new AggregateError(errors, "Scope cleanup failed");
    });
    return disposal;
  };
  scopeHosts.set(scoped, extensionHostContext(ctx));
  return { scoped, dispose, disposeAsync };
}

const extensionDisposers = new WeakMap<ExtensionContext, Map<string, { dispose: () => void; disposeAsync: () => Promise<void> }>>();


/**
 * Load extensions from three sources (merged, deduplicated):
 *
 * 1. CLI flags: -e / --extensions (npm packages or file paths)
 * 2. settings.json: ~/.agent-sh/settings.json → extensions[]
 * 3. Extensions dir: ~/.agent-sh/extensions/ (files and directories with index.{ts,js})
 *
 * Extension specifiers resolve as:
 *   - File path (relative or absolute) → import directly
 *   - Bare name → npm package (Node resolution)
 *
 * Each module should export a default or named `activate(ctx)` function.
 * Errors are non-fatal — logged via ui:error and skipped.
 */
export async function loadExtensions(
  ctx: ExtensionContext,
  cliExtensions?: string[],
): Promise<string[]> {
  const specifiers: string[] = [];

  if (cliExtensions) {
    specifiers.push(...cliExtensions);
  }

  const settings = getSettings();
  if (settings.extensions.length > 0) {
    specifiers.push(...settings.extensions);
  }

  const userSpecifiers = await discoverUserExtensions(ctx);
  specifiers.push(...userSpecifiers);

  const seen = new Set<string>();
  const unique = specifiers.filter((s) => {
    if (seen.has(s)) return false;
    seen.add(s);
    return true;
  });

  const loaded = await loadSpecifiers(unique, ctx, false);
  return loaded;
}

async function discoverUserExtensions(ctx: ExtensionContext): Promise<string[]> {
  const specifiers: string[] = [];
  const disabled = new Set(getSettings().disabledExtensions ?? []);

  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(EXT_DIR, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return specifiers;
    ctx.bus.emit("ui:error", {
      message: `Failed to read extensions directory ${EXT_DIR}: ${err instanceof Error ? err.message : String(err)}`,
    });
    return specifiers;
  }

  // tsx loads .ts outside a "type": "module" package as CommonJS, breaking ESM extensions on Node 20.19+.
  if (!entries.some((e) => e.name === "package.json")) {
    try { await fs.writeFile(path.join(EXT_DIR, "package.json"), '{ "type": "module" }\n'); } catch {}
  }

  for (const entry of entries) {
    // Disable check: directory name for dir-extensions, or basename sans
    // extension for file-extensions. Lets settings.json turn one off
    // without renaming it.
    const nameForDisable = entry.name.replace(/\.[^.]+$/, "");
    if (disabled.has(nameForDisable)) continue;

    const fullPath = path.join(EXT_DIR, entry.name);
    try {
      const isDir = entry.isDirectory() ||
        (entry.isSymbolicLink() && (await fs.stat(fullPath)).isDirectory());
      if (isDir) {
        const indexFile = await findIndex(fullPath);
        if (indexFile) specifiers.push(indexFile);
      } else if (SCRIPT_EXTS.some((ext) => entry.name.endsWith(ext))) {
        specifiers.push(fullPath);
      }
    } catch (err) {
      ctx.bus.emit("ui:error", {
        message: `Failed to inspect extension ${fullPath}: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
  return specifiers;
}

async function loadSpecifiers(
  specifiers: string[],
  ctx: ExtensionContext,
  bustCache: boolean,
): Promise<string[]> {
  const loaded: string[] = [];
  for (const specifier of specifiers) {
    try {
      let importPath = await resolveSpecifier(specifier);

      if (TS_EXTS.some((ext) => importPath.endsWith(ext))) {
        await ensureTsSupport(bustCache);
      }
      if (bustCache) {
        const sep = importPath.includes("?") ? "&" : "?";
        importPath += `${sep}t=${Date.now()}`;
      }
      const mod = await import(importPath);
      // tsx may double-wrap default exports: mod.default.default
      const activate = typeof mod.default === "function"
        ? mod.default
        : typeof mod.default?.default === "function"
          ? mod.default.default
          : mod.activate;
      if (typeof activate === "function") {
        const base = path.basename(specifier).replace(/\.(ts|js|mjs|mts|tsx)$/, "");
        const name = base === "index" ? path.basename(path.dirname(specifier)) : base;

        // Awaiting activate() lets extensions with async setup (e.g.
        // openrouter fetching its model catalog) finish before we move
        // on; a 10s outer timeout in index.ts guards against hangs.
        let disposers = extensionDisposers.get(ctx);
        if (!disposers) extensionDisposers.set(ctx, disposers = new Map());
        const previous = disposers.get(name);
        if (previous) {
          previous.dispose();
          await previous.disposeAsync().catch((err) => {
            ctx.bus.emit("ui:error", {
              message: `Async cleanup failed for extension ${name}: ${err instanceof Error ? err.message : String(err)}`,
            });
          });
        }
        disposers.delete(name);
        const { scoped, dispose, disposeAsync } = createScope(ctx, true);
        try {
          await activate(scoped);
        } catch (err) {
          dispose();
          throw err;
        }
        disposers.set(name, { dispose, disposeAsync });
        loaded.push(name);
      }
    } catch (err) {
      ctx.bus.emit("ui:error", {
        message: `Failed to load extension ${specifier}: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
  return loaded;
}

/**
 * Reload user extensions (from ~/.agent-sh/extensions/).
 * Tears down old registrations, busts the module cache, and re-activates.
 */
export async function reloadExtensions(ctx: ExtensionContext): Promise<string[]> {
  const specifiers = await discoverUserExtensions(ctx);
  return loadSpecifiers(specifiers, ctx, true);
}

/**
 * Find an index file in a directory extension.
 */
async function findIndex(dir: string): Promise<string | null> {
  for (const ext of SCRIPT_EXTS) {
    const candidate = path.join(dir, `index${ext}`);
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // try next
    }
  }
  return null;
}

/**
 * Resolve a specifier to an importable string.
 *
 * - Relative path (starts with ".") → resolve from cwd, file:// URL
 * - Absolute path → file:// URL (directories resolved to index file)
 * - Bare name → npm package (let Node resolve)
 */
async function resolveSpecifier(specifier: string): Promise<string> {
  let resolved: string;

  if (specifier.startsWith(".")) {
    resolved = path.resolve(process.cwd(), specifier);
  } else if (path.isAbsolute(specifier)) {
    resolved = specifier;
  } else {
    // Distinguish bare npm specifier from a relative path lacking "./".
    // Scoped packages ("@scope/pkg") contain "/" but are npm specifiers,
    // so the "@" prefix takes precedence over the "/" heuristic.
    if (specifier.includes("/") && !specifier.startsWith("@")) {
      resolved = path.resolve(process.cwd(), specifier);
    } else {
      return specifier;
    }
  }

  try {
    const stat = await fs.stat(resolved);
    if (stat.isDirectory()) {
      const indexFile = await findIndex(resolved);
      if (indexFile) {
        return `file://${indexFile}`;
      }
      throw new Error(`No index file found in ${resolved}`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // Not a directory, treat as file
    } else if (err instanceof Error && err.message.startsWith("No index")) {
      throw err;
    }
  }

  return `file://${resolved}`;
}
