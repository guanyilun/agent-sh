/**
 * Frontend bootstrap. Loaded directly from src/index.ts (not the built-in
 * extensions manifest) because PTY + stdin raw mode ownership is order-
 * critical. For pluggable capability extensions see `src/extensions/`.
 */
import type { ExtensionContext } from "../core/types.js";
import { Shell } from "./shell.js";
import { StdoutSurface } from "../utils/compositor.js";
import { TerminalBuffer } from "../utils/terminal-buffer.js";

export interface ShellActivateOptions {
  cols: number;
  rows: number;
  /** Path to the shell binary (zsh, bash, etc.). */
  shellPath: string;
  cwd: string;
  /** Optional callback used by the inline status indicator. */
  onShowAgentInfo?: () => { info: string; model?: string };
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
 * Register shell-owned handlers extensions can `ctx.call`. Must run before
 * `loadExtensions`; the handlers only need the bus, not the PTY.
 */
export function registerShellHandlers(ctx: ExtensionContext): void {
  let terminalBufferSingleton: TerminalBuffer | null | undefined;
  ctx.define("terminal-buffer", (): TerminalBuffer | null => {
    if (terminalBufferSingleton !== undefined) return terminalBufferSingleton;
    terminalBufferSingleton = TerminalBuffer.createWired(ctx.bus);
    return terminalBufferSingleton;
  });
}

/**
 * Construct the Shell, wire resize forwarding, and register cleanup with the
 * provided ExtensionContext. Returns a handle the caller (typically
 * `src/index.ts`) uses to drive lifecycle from process-level events.
 */
export function activateShell(
  ctx: ExtensionContext,
  opts: ShellActivateOptions,
): ShellHandle {
  // Stdout-as-default is a frontend choice, not a kernel one — a hub or
  // web bridge would point these at its own surfaces.
  const stdoutSurface = new StdoutSurface();
  ctx.compositor.setDefault("agent", stdoutSurface);
  ctx.compositor.setDefault("query", stdoutSurface);
  ctx.compositor.setDefault("status", stdoutSurface);

  const shell = new Shell({
    bus: ctx.bus,
    handlers: { define: ctx.define, call: ctx.call },
    cols: opts.cols,
    rows: opts.rows,
    shell: opts.shellPath,
    cwd: opts.cwd,
    instanceId: ctx.instanceId,
    onShowAgentInfo: opts.onShowAgentInfo,
  });

  const onResize = () => {
    shell.resize(process.stdout.columns || 80, process.stdout.rows || 24);
  };
  process.stdout.on("resize", onResize);

  ctx.onDispose(() => {
    process.stdout.off("resize", onResize);
    shell.kill();
  });

  return {
    kill: () => shell.kill(),
    onExit: (callback) => shell.onExit(callback),
    resize: (cols, rows) => shell.resize(cols, rows),
  };
}
