import { EventEmitter } from "node:events";

/** Typed event map — every event has a known payload shape. */
export interface BusEvents {
  // Core lifecycle
  "core:extensions-loaded": { names: string[] };

  // Cross-cutting "config might have changed, repaint" signal.
  "config:changed": Record<string, never>;

  // Universal UI feedback channel (any frontend may render; silently
  // ignored without one).
  "ui:info": { message: string };
  "ui:error": { message: string };
  "ui:suggestion": { text: string };

  // Banner section collection (sync pipe: extensions contribute
  // labeled items to startup banner emitted by the CLI).
  "banner:collect": {
    sections: Array<{ label: string; items: string[] }>;
    /** Name of the backend being launched. Extensions should gate per-backend sections on this rather than settings.defaultBackend. */
    activeBackend?: string;
  };
}

// ── Content block types (used by transform pipeline) ────────────

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "code-block"; language: string; code: string }
  | { type: "image"; data: Buffer }
  | { type: "raw"; escape: string };

type Listener<T> = (payload: T) => void;
type PipeListener<T> = (payload: T) => T;
type AsyncPipeListener<T> = (payload: T) => T | Promise<T>;

/** Envelope stamped on every emitted event. */
export interface BusMeta {
  source: string;   // emitting agent's instanceId
  ts: number;       // milliseconds since epoch
  id: string;       // monotonic per-bus, "<source>:<n>"
  name: string;     // event name
}

export type AnyListener = (name: string, payload: unknown, meta: BusMeta) => void;

/**
 * Typed event bus with two modes:
 * - emit/on/off: fire-and-forget notifications
 * - emitPipe/onPipe: synchronous transform chain where each listener
 *   can modify the payload before passing to the next
 */
export class EventBus {
  private emitter = new EventEmitter().setMaxListeners(0);
  private pipeListeners = new Map<string, PipeListener<any>[]>();
  private asyncPipeListeners = new Map<string, AsyncPipeListener<any>[]>();
  private source = "0000";
  private nextSeq = 0;
  private anyListeners: AnyListener[] = [];

  /** Set the source id stamped onto every emitted event. */
  setSource(src: string): void {
    this.source = src;
  }

  /** Subscribe to every emitted event with full envelope. Returns unsubscribe. */
  onAny(fn: AnyListener): () => void {
    this.anyListeners.push(fn);
    return () => {
      const i = this.anyListeners.indexOf(fn);
      if (i !== -1) this.anyListeners.splice(i, 1);
    };
  }

  /** Stamp + dispatch — used by every emit path. */
  private dispatch(name: string, payload: unknown): void {
    if (this.anyListeners.length > 0) {
      const meta: BusMeta = {
        source: this.source,
        ts: Date.now(),
        id: `${this.source}:${this.nextSeq++}`,
        name,
      };
      for (const fn of this.anyListeners) {
        try { fn(name, payload, meta); } catch { /* swallow */ }
      }
    }
    this.emitter.emit(name, payload);
  }

  /** Subscribe to a fire-and-forget event. */
  on<K extends keyof BusEvents>(
    event: K,
    fn: Listener<BusEvents[K]>,
  ): void {
    this.emitter.on(event, fn);
  }

  /** Unsubscribe from a fire-and-forget event. */
  off<K extends keyof BusEvents>(
    event: K,
    fn: Listener<BusEvents[K]>,
  ): void {
    this.emitter.off(event, fn);
  }

  /** Emit a fire-and-forget event. */
  emit<K extends keyof BusEvents>(
    event: K,
    payload: BusEvents[K],
  ): void {
    this.dispatch(event, payload);
  }

  /** Re-dispatch an event with externally-supplied meta. Used by bridges
   *  and replay tools to preserve the original source/ts/id of remote or
   *  recorded events instead of restamping them as locally originated. */
  relay(meta: BusMeta, payload: unknown): void {
    if (this.anyListeners.length > 0) {
      for (const fn of this.anyListeners) {
        try { fn(meta.name, payload, meta); } catch { /* swallow */ }
      }
    }
    this.emitter.emit(meta.name, payload);
  }

  /**
   * Transform-then-notify: run the payload through any registered pipe
   * listeners (transforms), then emit the final result to regular `on`
   * listeners (renderers). This enables content pipelines where extensions
   * modify data (e.g. render LaTeX → terminal image) before renderers see it.
   */
  emitTransform<K extends keyof BusEvents>(
    event: K,
    payload: BusEvents[K],
  ): void {
    let transformed: BusEvents[K];
    try {
      transformed = this.emitPipe(event, payload);
    } catch (err) {
      if (process.env.DEBUG) {
        process.stderr.write(`[event-bus] pipe error on ${String(event)}: ${err}\n`);
      }
      transformed = payload; // fall back to untransformed
    }
    this.dispatch(event, transformed);
  }

  /** Register a transform listener for a pipeline event. */
  onPipe<K extends keyof BusEvents>(
    event: K,
    fn: PipeListener<BusEvents[K]>,
  ): void {
    let listeners = this.pipeListeners.get(event);
    if (!listeners) {
      listeners = [];
      this.pipeListeners.set(event, listeners);
    }
    listeners.push(fn);
  }

  /** Remove a transform listener from a pipeline event. */
  offPipe<K extends keyof BusEvents>(
    event: K,
    fn: PipeListener<BusEvents[K]>,
  ): void {
    const listeners = this.pipeListeners.get(event);
    if (!listeners) return;
    const idx = listeners.indexOf(fn);
    if (idx !== -1) listeners.splice(idx, 1);
  }

  /**
   * Emit a pipeline event — each registered pipe listener receives the
   * output of the previous one. Returns the final transformed payload.
   * If no listeners are registered, returns the original payload unchanged.
   */
  emitPipe<K extends keyof BusEvents>(
    event: K,
    payload: BusEvents[K],
  ): BusEvents[K] {
    const listeners = this.pipeListeners.get(event);
    if (!listeners) return payload;
    let result = payload;
    for (const fn of listeners) {
      try {
        const out = fn(result);
        if (out && typeof (out as any).then === "function") {
          console.error(`[event-bus] Warning: async handler in sync pipe "${String(event)}" — use onPipeAsync instead`);
          continue;
        }
        result = out;
      } catch (err) {
        console.error(`[event-bus] Pipe handler error in "${String(event)}":`, err instanceof Error ? err.message : err);
      }
    }
    return result;
  }

  /** Remove an async transform listener from a pipeline event. */
  offPipeAsync<K extends keyof BusEvents>(
    event: K,
    fn: AsyncPipeListener<BusEvents[K]>,
  ): void {
    const listeners = this.asyncPipeListeners.get(event);
    if (!listeners) return;
    const idx = listeners.indexOf(fn);
    if (idx !== -1) listeners.splice(idx, 1);
  }

  /** Register an async transform listener for a pipeline event. */
  onPipeAsync<K extends keyof BusEvents>(
    event: K,
    fn: AsyncPipeListener<BusEvents[K]>,
  ): void {
    let listeners = this.asyncPipeListeners.get(event);
    if (!listeners) {
      listeners = [];
      this.asyncPipeListeners.set(event, listeners);
    }
    listeners.push(fn);
  }

  /**
   * Emit an async pipeline event. Two phases:
   * 1. Notify — fire regular `on` listeners synchronously (e.g., TUI flushes state)
   * 2. Transform — run async pipe listeners in series, each receiving the
   *    output of the previous (e.g., extension provides a permission decision)
   *
   * Returns the final transformed payload. If no pipe listeners are registered,
   * returns the original payload unchanged (with safe defaults).
   */
  async emitPipeAsync<K extends keyof BusEvents>(
    event: K,
    payload: BusEvents[K],
  ): Promise<BusEvents[K]> {
    // Phase 1: notify (lets renderers prepare for interactive I/O)
    this.dispatch(event, payload);

    // Phase 2: transform (extensions provide decisions)
    const listeners = this.asyncPipeListeners.get(event);
    if (!listeners) return payload;
    let result = payload;
    for (const fn of listeners) {
      result = await fn(result);
    }
    return result;
  }
}
