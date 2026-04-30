/**
 * Shell frontend bootstrap.
 *
 * Constructs the user-facing PTY shell and wires its lifecycle through the
 * extension API. Loaded specially from `src/index.ts` (not via the built-in
 * extensions manifest in `src/extensions/`) because shell ownership of stdin
 * raw mode and the PTY process is order-critical: it must exist before any
 * other code touches input or signals.
 *
 * For pluggable capability extensions (file-autocomplete, slash-commands,
 * provider built-ins, etc.) see `src/extensions/`.
 */
import type { ExtensionContext } from "../types.js";
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
 * Construct the Shell, wire resize forwarding, and register cleanup with the
 * provided ExtensionContext. Returns a handle the caller (typically
 * `src/index.ts`) uses to drive lifecycle from process-level events.
 */
export function activateShell(
  ctx: ExtensionContext,
  opts: ShellActivateOptions,
): ShellHandle {
  // ── Compositor defaults ──────────────────────────────────────
  // The kernel's Compositor is generic; the choice of stdout as the
  // default surface is shell-frontend-specific (a hub or web frontend
  // would set its own surfaces). We assert it here, not in core.
  const stdoutSurface = new StdoutSurface();
  ctx.compositor.setDefault("agent", stdoutSurface);
  ctx.compositor.setDefault("query", stdoutSurface);
  ctx.compositor.setDefault("status", stdoutSurface);

  // ── Terminal buffer handler ──────────────────────────────────
  // The xterm.js headless mirror is a PTY-derived artifact, so it lives
  // with the shell extension. Lazy because @xterm/headless is optional
  // and creating the buffer is non-trivial; null when the package isn't
  // installed. Consumers call ctx.call("terminal-buffer").
  let terminalBufferSingleton: TerminalBuffer | null | undefined;
  ctx.define("terminal-buffer", (): TerminalBuffer | null => {
    if (terminalBufferSingleton !== undefined) return terminalBufferSingleton;
    terminalBufferSingleton = TerminalBuffer.createWired(ctx.bus);
    return terminalBufferSingleton;
  });

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
