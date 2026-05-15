import type { EventBus } from "../core/event-bus.js";
import type { AgentConfig, AgentContext } from "../agent/host-types.js";
import type { ColorPalette } from "../utils/palette.js";
import type { Compositor, RenderSurface } from "../utils/compositor.js";
import type { BlockTransformOptions, FencedBlockTransformOptions } from "../utils/stream-transform.js";

export type { BlockTransformOptions, FencedBlockTransformOptions } from "../utils/stream-transform.js";
export type { RenderSurface } from "../utils/compositor.js";

// ── Remote sessions ──────────────────────────────────────────────

export interface RemoteSessionOptions {
  /** The surface to render agent output to. */
  surface: RenderSurface;
  /** Suppress response borders (default: true). */
  suppressBorders?: boolean;
  /** Suppress user query box (default: false).
   *  True for sessions with their own input (rsplit, overlay).
   *  False for sessions where input comes from the main shell (split). */
  suppressQueryBox?: boolean;
  /** Suppress usage stats line (default: true). */
  suppressUsage?: boolean;
}

export interface RemoteSession {
  /** Submit a query to the agent from this session. */
  submit(query: string): void;
  /** The surface this session renders to. */
  readonly surface: RenderSurface;
  /** Whether this session is currently active. */
  readonly active: boolean;
  /** Tear down — restores all routing and advisors. */
  close(): void;
}

// ── Input modes ──────────────────────────────────────────────────

/**
 * Configuration for a registered input mode.
 * Extensions emit "input-mode:register" with this shape to add new modes.
 */
export interface InputModeConfig {
  id: string;              // unique identifier, e.g. "agent", "translate"
  trigger: string;         // single char trigger at empty line start: "?", ">"
  label: string;           // human-readable label shown in prompt
  promptIcon: string;      // the chevron/icon character, e.g. "❯", "⟩"
  indicator: string;       // status indicator shown before the icon, e.g. "❓", "●"
  onSubmit(query: string, bus: EventBus): void;
  returnToSelf: boolean;   // re-enter this mode after agent processing?
}

export interface TerminalSession {
  id: string;
  command: string;
  output: string;
  exitCode: number | null;
  done: boolean;
  resolve?: (value: void) => void;
}

// ── Shell-host extension surface ─────────────────────────────────

/**
 * Capabilities the shell host adds on top of AgentContext. Available
 * only when the shell frontend is loaded; headless backends omit these,
 * so extensions that need them should type as ShellContext.
 */
export interface ShellSurface {
  /** Routes named render streams ("agent", "query", "status") to surfaces.
   *  Extensions use `compositor.redirect()` to capture output. */
  compositor: Compositor;

  /** Override color palette slots for theming. */
  setPalette: (overrides: Partial<ColorPalette>) => void;

  // ── Stream transform utilities ─────────────────────────────
  /** Register a delimiter-based content transform (e.g. $$...$$ → image). */
  createBlockTransform: (opts: BlockTransformOptions) => void;
  /** Register a fenced block transform (e.g. ```lang...``` → code-block). */
  createFencedBlockTransform: (opts: FencedBlockTransformOptions) => void;

  // ── Input mode registration ───────────────────────────────
  /** Wrap an input mode's `onSubmit`. Lets extensions transform queries
   *  on the way to the agent (logging, redaction, vetoing). The mode
   *  must already be registered via the `input-mode:register` bus event. */
  adviseInputMode: (
    id: string,
    advisor: (
      next: (query: string, bus: EventBus) => void,
      query: string,
      bus: EventBus,
    ) => void,
  ) => () => void;

  // ── Slash command registration ─────────────────────────────
  registerCommand: (name: string, description: string, handler: (args: string) => Promise<void> | void) => void;
  /** Wrap an already-registered command's handler. Name is normalized
   *  (leading `/` optional). */
  adviseCommand: (
    name: string,
    advisor: (
      next: (args: string) => Promise<void> | void,
      args: string,
    ) => Promise<void> | void,
  ) => () => void;

  // ── Remote sessions ────────────────────────────────────────
  /**
   * Create a remote session that routes agent output to a surface and
   * optionally accepts queries. Handles all compositor routing, shell
   * lifecycle advisors, and chrome suppression.
   *
   *   const session = ctx.createRemoteSession({ surface });
   *   session.submit("what's on screen?");
   *   session.close();  // restores everything
   */
  createRemoteSession: (opts: RemoteSessionOptions) => RemoteSession;
}

export type ShellContext = AgentContext & ShellSurface;

// ── Shell-host config surface ────────────────────────────────────

export interface ShellConfigSurface {
  /** Shell binary (e.g. /bin/zsh) launched by the PTY frontend. */
  shell?: string;
}

export type ShellConfig = AgentConfig & ShellConfigSurface;

// ── Back-compat aliases ──────────────────────────────────────────
// The historical `ExtensionContext` was the full shell surface, and
// `AgentShellConfig` the full shell config. Keep these names so existing
// internal and external imports continue to resolve.

export type ExtensionContext = ShellContext;
export type AgentShellConfig = ShellConfig;

/** Friendly alias for `ShellConfig` — the full application config blob
 *  passed to `createCore()`. Prefer this in CLI/embedder code; layered
 *  names (`CoreConfig`, `AgentConfig`, `ShellConfig`) are for code that
 *  cares about which host owns which fields. */
export type AppConfig = ShellConfig;
