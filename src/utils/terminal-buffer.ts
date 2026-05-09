/**
 * Headless terminal buffer backed by xterm.js.
 *
 * Provides accurate terminal screen capture — correctly handles ANSI
 * codes, cursor movement, alternate screen (vim/htop), line wrapping,
 * and scrollback.
 *
 * Used by:
 *   - floating-panel.ts: composited overlay rendering + screen restore
 *   - terminal-buffer extension: agent tools (terminal_read, terminal_keys)
 *   - Any extension needing a virtual terminal snapshot
 */
// `@xterm/headless` is a CJS module; Node ESM only supports its default
// import at runtime. Types are imported separately so the named imports
// are fully erased.
import xtermPkg from "@xterm/headless";
import type { Terminal, IBuffer, IBufferLine } from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";
import type { EventBus } from "../event-bus.js";

const TerminalCtor = xtermPkg.Terminal;

// ── Types ───────────────────────────────────────────────────────

export interface TerminalBufferConfig {
  /** Terminal width in columns. Default: process.stdout.columns || 80. */
  cols?: number;
  /** Terminal height in rows. Default: process.stdout.rows || 24. */
  rows?: number;
  /** Scrollback buffer size. Default: 200. */
  scrollback?: number;
}

export interface ScreenSnapshot {
  /** Clean text with ANSI sequences stripped. */
  text: string;
  /** Whether the alternate screen buffer is active (vim, htop, etc.). */
  altScreen: boolean;
  /** Cursor position. */
  cursorX: number;
  cursorY: number;
}

/**
 * Format a screen snapshot as an XML context block for agent injection.
 * Trims, caps to `maxLines` (from the bottom), and wraps in `<terminal_buffer>`.
 * Returns the combined context string (baseContext + section), or just
 * baseContext if the screen is empty.
 */
export function formatScreenContext(
  screen: ScreenSnapshot,
  maxLines = 80,
  baseContext?: string,
): string {
  const trimmed = screen.text.trim();
  if (!trimmed) return baseContext ?? "";

  const lines = trimmed.split("\n");
  const capped = lines.length > maxLines
    ? lines.slice(-maxLines).join("\n")
    : trimmed;

  const header = screen.altScreen
    ? "<terminal_buffer mode=\"alternate\">"
    : "<terminal_buffer>";
  const section = `${header}\n${capped}\n</terminal_buffer>`;
  return baseContext ? baseContext + "\n" + section : section;
}

// ── TerminalBuffer ──────────────────────────────────────────────

export class TerminalBuffer {
  private readonly term: Terminal;
  private readonly serializeAddon: SerializeAddon;

  /** Flush pending drip-feed data (set by createWired). */
  _flushPending: (() => void) | null = null;

  private constructor(term: Terminal, serialize: SerializeAddon) {
    this.term = term;
    this.serializeAddon = serialize;
  }

  static create(config?: TerminalBufferConfig): TerminalBuffer {
    const cols = config?.cols ?? (process.stdout.columns || 80);
    const rows = config?.rows ?? (process.stdout.rows || 24);
    const scrollback = config?.scrollback ?? 200;

    const term = new TerminalCtor({ cols, rows, allowProposedApi: true, scrollback });
    const serialize = new SerializeAddon();
    term.loadAddon(serialize);
    return new TerminalBuffer(term, serialize);
  }

  /**
   * Create a TerminalBuffer wired to a bus's `shell:pty-data` event.
   * Drip-feeds writes asynchronously: synchronous `term.write()` in the
   * pty-data handler changes PTY read coalescing enough to introduce
   * visual artifacts.
   */
  static createWired(bus: EventBus, config?: TerminalBufferConfig): TerminalBuffer {
    const tb = TerminalBuffer.create(config);
    let pending = "";
    bus.on("shell:pty-data", ({ raw }) => { pending += raw; });
    setInterval(() => {
      if (pending) { const d = pending; pending = ""; tb.write(d); }
    }, 50);
    tb._flushPending = () => {
      if (pending) { const d = pending; pending = ""; tb.write(d); }
    };
    process.stdout.on("resize", () => {
      tb.resize(process.stdout.columns || 80, process.stdout.rows || 24);
    });
    return tb;
  }

  /** Flush any pending drip-feed data into the virtual terminal. */
  flush(): void {
    this._flushPending?.();
  }

  /** Write raw data into the virtual terminal. */
  write(data: string): void {
    this.term.write(data);
  }

  /** Get the raw serialized terminal output (includes ANSI sequences). */
  serialize(): string {
    return this.serializeAddon.serialize();
  }

  /** Read clean screen text with metadata. */
  readScreen(opts?: { includeScrollback?: boolean }): ScreenSnapshot {
    const buf = this.term.buffer.active;
    const lines = opts?.includeScrollback
      ? this.readAllLines(buf)
      : this.readViewportLines(buf);
    return {
      text: lines.join("\n"),
      altScreen: buf.type === "alternate",
      cursorX: buf.cursorX,
      cursorY: buf.cursorY,
    };
  }

  /**
   * Get terminal screen as lines, padded/trimmed to exactly `rows` lines.
   * Clean text only (ANSI stripped).  Reads from the active buffer's
   * viewport (not scrollback), so it works correctly on both the normal
   * and alternate screen buffers.
   */
  getScreenLines(rows?: number): string[] {
    const targetRows = rows ?? (process.stdout.rows || 24);
    return this.readViewportLines(this.term.buffer.active, targetRows);
  }

  /** Read visible viewport lines from a buffer. */
  private readViewportLines(buf: IBuffer, rows?: number): string[] {
    const targetRows = rows ?? buf.length;
    const base = buf.baseY ?? 0;
    const lines: string[] = [];
    for (let y = 0; y < targetRows; y++) {
      const line: IBufferLine | undefined = buf.getLine(base + y);
      lines.push(line ? line.translateToString(true) : "");
    }
    return lines;
  }

  /** Read all lines including scrollback from a buffer. */
  private readAllLines(buf: IBuffer): string[] {
    const total = (buf.baseY ?? 0) + buf.length;
    const lines: string[] = [];
    for (let y = 0; y < total; y++) {
      const line: IBufferLine | undefined = buf.getLine(y);
      lines.push(line ? line.translateToString(true) : "");
    }
    while (lines.length > 0 && lines[lines.length - 1] === "") {
      lines.pop();
    }
    return lines;
  }

  /** Get cursor position. */
  getCursor(): { x: number; y: number } {
    return {
      x: this.term.buffer.active.cursorX,
      y: this.term.buffer.active.cursorY,
    };
  }

  /** Resize the virtual terminal. */
  resize(cols: number, rows: number): void {
    this.term.resize(cols, rows);
  }

  /** Whether the alternate screen buffer is active. */
  get altScreen(): boolean {
    return this.term.buffer.active.type === "alternate";
  }
}
