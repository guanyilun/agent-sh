/**
 * Frontend bootstrap. Loaded directly from src/cli/index.ts (not the
 * built-in extensions manifest) because PTY + stdin raw mode ownership is
 * order-critical.
 */
import "./events.js"; // augments BusEvents with shell-owned events
import type { ExtensionContext, RemoteSession, RemoteSessionOptions, ShellSurface } from "./host-types.js";
import type { EventBus } from "../core/event-bus.js";
import { Shell } from "./shell.js";
import { DefaultCompositor } from "../utils/compositor.js";
import { TerminalBuffer } from "../utils/terminal-buffer.js";
import { FloatingPanel, type FloatingPanelConfig } from "../utils/floating-panel.js";
import { setPalette } from "../utils/palette.js";
import * as streamTransform from "../utils/stream-transform.js";
import activateShellContext from "./shell-context.js";
import activateTuiRenderer from "./tui-renderer.js";
import { type Terminal, processTerminal, surfaceFromTerminal } from "./terminal.js";

export interface ShellActivateOptions {
  cols: number;
  rows: number;
  /** Path to the shell binary (zsh, bash, etc.). */
  shellPath: string;
  cwd: string;
  /** Optional callback used by the inline status indicator. */
  onShowAgentInfo?: () => { info: string; model?: string };
  /**
   * Host-side I/O endpoint. Defaults to processTerminal() so the CLI
   * works unchanged; headless callers (web hubs, tests) supply their own.
   */
  terminal?: Terminal;
}

export interface ShellHandle {
  /** Terminate the PTY. */
  kill(): void;
  /** Subscribe to PTY exit. The frontend uses this to clean up + exit. */
  onExit(callback: (e: { exitCode: number; signal?: number }) => void): void;
  /** Forward terminal size changes to the PTY. */
  resize(cols: number, rows: number): void;
}

/**
 * Register shell-owned handlers extensions can `ctx.call`, and attach
 * the shell surface to ctx. Must run before `loadExtensions` so user
 * extensions see `ctx.shell` populated.
 */
export function registerShellHandlers(ctx: ExtensionContext): void {
  const { bus } = ctx;
  const compositor = new DefaultCompositor(bus);

  const shellSurface: ShellSurface = {
    compositor,
    setPalette,
    createBlockTransform: (o) => streamTransform.createBlockTransform(bus, o),
    createFencedBlockTransform: (o) => streamTransform.createFencedBlockTransform(bus, o),
    adviseInputMode: (id, advisor) => ctx.advise(`input-mode:${id}:submit`, advisor as Parameters<typeof ctx.advise>[1]),
    createRemoteSession: (sessOpts: RemoteSessionOptions): RemoteSession => {
      const { surface } = sessOpts;
      const cleanups: (() => void)[] = [];
      let active = true;

      cleanups.push(compositor.redirect("agent", surface));
      cleanups.push(compositor.redirect("query", surface));
      cleanups.push(compositor.redirect("status", surface));

      // on-processing-done is intentionally not advised — its scope
      // cleanup must always run.
      cleanups.push(ctx.advise("shell:on-processing-start", (next) => active ? undefined : next()));
      cleanups.push(ctx.advise("shell:on-processing-redraw", (next) => active ? undefined : next()));

      if (sessOpts.suppressBorders !== false) {
        cleanups.push(ctx.advise("tui:response-border", (next, ...a) => active ? null : next(...a)));
      }
      if (sessOpts.suppressQueryBox) {
        cleanups.push(ctx.advise("tui:render-user-query", (next, ...a) => active ? [] : next(...a)));
      }
      if (sessOpts.suppressUsage !== false) {
        cleanups.push(ctx.advise("tui:render-usage", (next, ...a) => active ? "" : next(...a)));
      }
      return {
        submit(query: string) { bus.emit("agent:submit", { query }); },
        get surface() { return surface; },
        get active() { return active; },
        close() {
          if (!active) return;
          active = false;
          for (const fn of cleanups.reverse()) fn();
          cleanups.length = 0;
        },
      };
    },
  };
  (ctx as { shell?: ShellSurface }).shell = shellSurface;

  let terminalBufferSingleton: TerminalBuffer | null | undefined;
  ctx.define("terminal-buffer", (): TerminalBuffer | null => {
    if (terminalBufferSingleton !== undefined) return terminalBufferSingleton;
    terminalBufferSingleton = TerminalBuffer.createWired(ctx.bus);
    return terminalBufferSingleton;
  });

  // bus override lets callers pass their scoped bus, so the panel's
  // listeners unwire when the extension reloads.
  ctx.define("floating-panel:create", (config: FloatingPanelConfig, bus?: EventBus): FloatingPanel =>
    new FloatingPanel(bus ?? ctx.bus, config),
  );

  activateShellContext(ctx);
  activateTuiRenderer(ctx);
}

/**
 * Construct the Shell, wire resize forwarding, and register cleanup with the
 * provided ExtensionContext. Returns a handle the caller (typically
 * `src/cli/index.ts`) uses to drive lifecycle from process-level events.
 */
export function activateShell(
  ctx: ExtensionContext,
  opts: ShellActivateOptions,
): ShellHandle {
  const terminal = opts.terminal ?? processTerminal();
  const surface = surfaceFromTerminal(terminal);
  ctx.shell!.compositor.setDefault("agent", surface);
  ctx.shell!.compositor.setDefault("query", surface);
  ctx.shell!.compositor.setDefault("status", surface);

  const shell = new Shell({
    bus: ctx.bus,
    handlers: { define: ctx.define, call: ctx.call },
    cols: opts.cols,
    rows: opts.rows,
    shell: opts.shellPath,
    cwd: opts.cwd,
    instanceId: ctx.instanceId,
    onShowAgentInfo: opts.onShowAgentInfo,
    terminal,
  });

  const offResize = terminal.onResize((cols, rows) => shell.resize(cols, rows));

  ctx.onDispose(() => {
    offResize();
    shell.kill();
  });

  return {
    kill: () => shell.kill(),
    onExit: (callback) => shell.onExit(callback),
    resize: (cols, rows) => shell.resize(cols, rows),
  };
}
