import type { EventBus } from "./event-bus.js";
import type { Compositor } from "../utils/compositor.js";

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

  /** Read extension-namespaced settings from ~/.agent-sh/settings.json. */
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
  /** Call a named handler. */
  call: (name: string, ...args: any[]) => any;
  /** Names of all registered handlers — for diagnostic / introspection use. */
  list: () => string[];

  /** Teardown callback fired on /reload. For resources the scoped context
   *  can't track: process listeners, timers, watchers, sockets. */
  onDispose: (fn: () => void) => void;

  /** Generic surface-routing primitive. Routes named render streams
   *  ("agent", "query", "status", or any extension-defined name) to
   *  surfaces. Frontends register the default surface for each stream
   *  during their activation; extensions can `redirect()` a stream to
   *  capture output (overlay panels, ACP framing, web sinks). Substrate
   *  rather than shell because it's frontend-agnostic — TUI, ACP, web,
   *  and headless test harnesses all use it. */
  compositor: Compositor;
}

// ── Core config ───────────────────────────────────────────────────

/**
 * The substrate config — kernel-level options. Hosts extend with their
 * own surfaces (see AgentConfig in src/agent/host-types.ts and
 * ShellConfig in src/shell/host-types.ts).
 */
export interface CoreConfig {
  /** Extension specifiers (paths or package names) to load on startup. */
  extensions?: string[];
  /** Override settings.defaultBackend for this session only (does not persist). */
  backend?: string;
}
