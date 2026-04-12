/**
 * Abstraction over terminal output.
 *
 * All TUI rendering goes through an OutputWriter instead of calling
 * process.stdout.write directly.  This enables testing (BufferWriter),
 * alternative frontends, and a single point of control for output.
 */

export interface OutputWriter {
  write(text: string): void;
  get columns(): number;
}

/** Default writer that forwards to process.stdout. */
export class StdoutWriter implements OutputWriter {
  /** When > 0, all writes are silently dropped. Ref-counted. */
  private _holdCount = 0;

  hold(): void { this._holdCount++; }
  release(): void { this._holdCount = Math.max(0, this._holdCount - 1); }
  get held(): boolean { return this._holdCount > 0; }

  write(text: string): void {
    if (this._holdCount > 0) return;
    if (process.stdout.writable) {
      try { process.stdout.write(text); } catch {}
    }
  }
  get columns(): number {
    return process.stdout.columns || 80;
  }
}

/** Captures all output in memory. Useful for testing. */
export class BufferWriter implements OutputWriter {
  output: string[] = [];
  columns = 80;
  write(text: string): void {
    this.output.push(text);
  }
}
