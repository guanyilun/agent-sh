import type { EventBus } from "../core/event-bus.js";
import type { CoreConfig, CoreContext } from "../core/types.js";
import type { AgentSurface } from "../agent/host-types.js";
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

// ── Shell-host surface ───────────────────────────────────────────

/**
 * Capabilities the shell host adds to the extension context, exposed
 * on the nested `ctx.shell` field. Available only when the TUI shell
 * frontend is loaded; under headless backends these methods are silent
 * no-ops (bus emits with no listeners).
 */
export interface ShellSurface {
  /** Routes named render streams ("agent", "query", "status", or any
   *  extension-defined name) to terminal surfaces. Frontends register
   *  default surfaces during activation; extensions can `redirect()`
   *  to capture output. Shell-scoped because today only the TUI uses
   *  it — bus events are the wire for other frontends. */
  compositor: Compositor;

  /** Override color palette slots for theming. */
  setPalette: (overrides: Partial<ColorPalette>) => void;

  /** Register a delimiter-based content transform (e.g. $$...$$ → image). */
  createBlockTransform: (opts: BlockTransformOptions) => void;
  /** Register a fenced block transform (e.g. ```lang...``` → code-block). */
  createFencedBlockTransform: (opts: FencedBlockTransformOptions) => void;

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

  /** Create a remote session that routes agent output to a surface and
   *  optionally accepts queries. Handles compositor routing, shell
   *  lifecycle advisors, and chrome suppression. */
  createRemoteSession: (opts: RemoteSessionOptions) => RemoteSession;
}

/** Substrate + shell surface. Use this when an extension only touches
 *  shell features (themes, palette, transforms) and doesn't need the
 *  agent surface. */
export type ShellContext = CoreContext & { shell: ShellSurface };

// ── Extension-facing context ─────────────────────────────────────

/**
 * What extension `activate()` functions receive. Substrate (`CoreContext`)
 * + slash-command registration + host surfaces, which are **optional**
 * because hosts attach them on activation: under headless backends
 * `ctx.shell` is undefined; under bridge backends `ctx.agent` may be
 * undefined too. Extensions guard with `ctx.shell?.foo()` /
 * `if (!ctx.agent) return;`, or type their parameter as the narrower
 * `AgentContext` / `ShellContext` to declare host requirements (those
 * variants make the surface non-optional). When both hosts are required,
 * intersect them at the use site: `ctx: AgentContext & ShellContext`.
 */
export type ExtensionContext = CoreContext & {
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
  agent?: AgentSurface;
  shell?: ShellSurface;
};

// ── Shell-host config surface ────────────────────────────────────

export interface ShellConfigSurface {
  /** Shell binary (e.g. /bin/zsh) launched by the PTY frontend. */
  shell?: string;
}

export type ShellConfig = CoreConfig & ShellConfigSurface;

/** The full application config — substrate + agent + shell startup options.
 *  Prefer this in CLI/embedder code; layered names (`CoreConfig`,
 *  `AgentConfig`, `ShellConfig`) are for code that cares about which
 *  host owns which fields. */
export type AppConfig = CoreConfig & import("../agent/host-types.js").AgentConfigSurface & ShellConfigSurface;
