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
      const wasRaw = process.stdin.isTTY && (process.stdin as { isRaw?: boolean }).isRaw;
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
    },
  };
}

/**
 * No-op terminal for non-rendering hosts (tests, agent-only embeds).
 * Writes are discarded; input/resize never fire.
 */
export function headlessTerminal(cols = 100, rows = 30): Terminal {
  return {
    write() {},
    onInput: () => () => {},
    onResize: () => () => {},
    cols: () => cols,
    rows: () => rows,
  };
}

/**
 * Pipe-based terminal for embedders that own their own renderer (web hubs
 * via xterm.js, electron windows, recording harnesses). Bytes from the
 * Shell flow through `onWrite`; the host drives `pushInput`/`pushResize`
 * to forward keystrokes and viewport changes back.
 */
export class BridgedTerminal implements Terminal {
  private inputCbs = new Set<(d: string) => void>();
  private resizeCbs = new Set<(c: number, r: number) => void>();
  private _cols: number;
  private _rows: number;
  constructor(private readonly onWrite: (data: string) => void, cols = 100, rows = 30) {
    this._cols = cols;
    this._rows = rows;
  }
  write(data: string): void { this.onWrite(data); }
  onInput(cb: (d: string) => void): () => void { this.inputCbs.add(cb); return () => { this.inputCbs.delete(cb); }; }
  onResize(cb: (c: number, r: number) => void): () => void { this.resizeCbs.add(cb); return () => { this.resizeCbs.delete(cb); }; }
  cols(): number { return this._cols; }
  rows(): number { return this._rows; }
  pushInput(data: string): void { for (const cb of this.inputCbs) cb(data); }
  pushResize(cols: number, rows: number): void {
    this._cols = cols;
    this._rows = rows;
    for (const cb of this.resizeCbs) cb(cols, rows);
  }
}

/**
 * Adapt a Terminal to a RenderSurface (the compositor's sink type). Adds
 * the OPOST-cleared `\n` → `\r\n` translation that StdoutSurface applies,
 * since the PTY has OPOST disabled.
 */
export function surfaceFromTerminal(terminal: Terminal): RenderSurface {
  const write = (text: string) => terminal.write(text.replace(/(?<!\r)\n/g, "\r\n"));
  return {
    write,
    writeLine: (line) => write(line + "\n"),
    get columns() { return terminal.cols(); },
    get rows() { return terminal.rows(); },
    onResize: (cb) => terminal.onResize(cb),
  };
}
