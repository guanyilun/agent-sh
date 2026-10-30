import type { EventBus } from "./event-bus.js";
import type { SettingsService } from "./settings.js";

export type { ContentBlock } from "./event-bus.js";

// ── Core extension context ────────────────────────────────────────

/**
 * The substrate context — what every backend and every host always
 * provides. Bus, handler registry, lifecycle, and per-instance storage.
 *
 * Hosts (agent, shell, web bridge, …) extend this with their own
 * surfaces — see src/agent/host-types.ts and src/shell/host-types.ts.
 * Extensions that only need the substrate should type their ctx as
 * `CoreContext`; those that need host facilities should type as
 * `AgentContext` or `ShellContext` to make their host dependency
 * explicit (and catch misuse under bridge backends at the type level).
 */
export interface CoreContext {
  bus: EventBus;
  /** Stable per-instance identifier (4-char hex). */
  readonly instanceId: string;
  quit: () => void;

  /** Read extension-namespaced settings from this host's settings service. */
  getExtensionSettings: <T extends Record<string, unknown>>(namespace: string, defaults: T) => T;

  /**
   * Get (and lazily create) a per-extension storage directory under
   * ~/.agent-sh/<namespace>/. Returns the absolute path. Lets extensions
   * persist state without each one re-deriving the location.
   */
  getStoragePath: (namespace: string) => string;

  // ── Named handler registry (Emacs-style advice) ───────────
  /** Register a named handler. */
  define: (name: string, fn: (...args: any[]) => any) => void;
  /** Wrap a named handler. Receives `next` (original) + args. Returns an unadvise function. */
  advise: (name: string, wrapper: (next: (...args: any[]) => any, ...args: any[]) => any) => () => void;
  /** Call a named handler. `config:settings` returns this host's SettingsService. */
  call: (name: string, ...args: any[]) => any;
  /** Names of all registered handlers — for diagnostic / introspection use. */
  list: () => string[];
  /** True when a base handler is registered (advice alone does not count). */
  hasBase: (name: string) => boolean;

  /** Teardown callback fired on /reload. For resources the scoped context
   *  can't track: process listeners, timers, watchers, sockets. */
  onDispose: (fn: () => void) => void;
}

// ── Core config ───────────────────────────────────────────────────

/**
 * The substrate config — kernel-level options. Hosts extend with their
 * own surfaces (see AgentConfig in src/agent/host-types.ts and
 * ShellConfig in src/shell/host-types.ts).
 */
export interface CoreConfig {
  /** Instance settings; omitted uses the legacy process-global disk/env service. */
  settingsService?: SettingsService;
  /** Alias for settingsService. settingsService takes precedence when both are set. */
  settings?: SettingsService;
  /** Extension specifiers (paths or package names) to load on startup. */
  extensions?: string[];
  /** Override settings.defaultBackend for this session only (does not persist). */
  backend?: string;
}
