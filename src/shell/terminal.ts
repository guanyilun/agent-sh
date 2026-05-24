/**
 * Terminal — the user-facing I/O endpoint that a Shell talks to.
 *
 * Shell wraps a *pseudo*-terminal (the PTY the child shell sees). This
 * interface is the *real* terminal (or its substitute) on the other end:
 * bytes in, bytes out, dimensions, resize notifications. The default
 * factory wires it to process.stdin/stdout for the CLI; headless hosts
 * (multi-session web hubs, tests) supply their own.
 */
import type { RenderSurface } from "../utils/compositor.js";

export interface Terminal {
  write(data: string): void;
  onInput(cb: (data: string) => void): () => void;
  onResize(cb: (cols: number, rows: number) => void): () => void;
  cols(): number;
  rows(): number;
  /**
   * Called around PTY spawn to avoid TTY contention: the child PTY becomes
   * the controlling tty for the spawned shell. No-op when the terminal
   * isn't a real tty.
   */
  suspendInput?(): { resume(): void };
}

/** Default Terminal: wraps process.stdin/stdout. */
export function processTerminal(): Terminal {
  return {
    write(data) {
      if (process.stdout.writable) {
        try { process.stdout.write(data); } catch { /* ignore */ }
      }
    },
    onInput(cb) {
      const handler = (b: Buffer) => cb(b.toString("utf-8"));
      process.stdin.on("data", handler);
      return () => { process.stdin.off("data", handler); };
    },
    onResize(cb) {
      const handler = () => cb(process.stdout.columns || 80, process.stdout.rows || 24);
      process.stdout.on("resize", handler);
      return () => { process.stdout.off("resize", handler); };
    },
    cols() { return process.stdout.columns || 80; },
    rows() { return process.stdout.rows || 24; },
    suspendInput() {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const wasRaw = process.stdin.isTTY && (process.stdin as any).isRaw;
      if (process.stdin.isTTY) {
        try {
          process.stdin.setRawMode(false);
          process.stdin.pause();
        } catch { /* ignore */ }
      }
      return {
        resume() {
          if (process.stdin.isTTY) {
            try {
              process.stdin.resume();
              if (wasRaw) process.stdin.setRawMode(true);
            } catch { /* ignore */ }
          }
        },
      };
      /* eslint-enable @typescript-eslint/no-explicit-any */
    },
  };
}

/**
 * Adapt a Terminal to a RenderSurface (the compositor's sink type). Adds
 * the OPOST-cleared `\n` → `\r\n` translation that StdoutSurface applies,
 * since the PTY has OPOST disabled.
 */
export function surfaceFromTerminal(terminal: Terminal): RenderSurface {
  return {
    write(text: string) {
      terminal.write(text.replace(/(?<!\r)\n/g, "\r\n"));
    },
    writeLine(line: string) {
      this.write(line + "\n");
    },
    get columns() { return terminal.cols(); },
    get rows() { return terminal.rows(); },
    onResize(cb) { return terminal.onResize(cb); },
  };
}
