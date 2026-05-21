import { EventEmitter } from "node:events";

/**
 * Typed event map — every event has a known payload shape.
 *
 * Core defines only cross-cutting transport events (shell, command,
 * ui, compositor, input). Domain-specific events are owned by their
 * extensions and merged in via TypeScript declaration merging:
 *   - agent:*, conversation:*, context:*, config:switch-model,
 *     config:get-models, config:set-thinking, config:get-thinking,
 *     tool:interactive-*  → src/extensions/agent-backend/events.ts
 *   - provider:*, config:switch-provider, config:get-initial-modes,
 *     config:set-modes, config:add-modes, llm:*  → src/agent/events.ts
 */
export interface ShellEvents {
  // Shell lifecycle
  "shell:command-start": { command: string; cwd: string };
  "shell:command-done": {
    command: string;
    output: string;
    cwd: string;
    exitCode: number | null;
  };
  "shell:cwd-change": { cwd: string };
  "shell:foreground-busy": { busy: boolean };
  "shell:agent-exec-start": Record<string, never>;
  "shell:agent-exec-done": Record<string, never>;

  // Raw PTY output stream (every byte from the shell process).
  // Extensions can use this to feed a virtual terminal, log, or replay.
  "shell:pty-data": { raw: string };

  // Write raw bytes to the PTY (keystroke injection).
  // Extensions use this to send keystrokes into the user's live shell.
  "shell:pty-write": { data: string };

  // Resize the PTY (triggers SIGWINCH in the child process).
  "shell:pty-resize": { cols: number; rows: number };

  // Terminal buffer snapshot (request/response pattern via bus)
  "shell:buffer-request": Record<string, never>;
  "shell:buffer-snapshot": {
    text: string;
    altScreen: boolean;
    cursor: { x: number; y: number };
  };

  // Input mode registration (extensions → InputHandler)
  "input-mode:register": import("../shell/host-types.js").InputModeConfig;

  // Slash command registration (extensions → slash-commands)
  "command:register": {
    name: string;
    description: string;
    handler: (args: string) => Promise<void> | void;
  };
  "command:unregister": { name: string };

  // Slash command execution
  "command:execute": {
    name: string;
    args: string;
  };

  // UI feedback (TUI subscribes to render; silently ignored without TUI)
  "ui:info": { message: string };
  "ui:error": { message: string };
  "ui:suggestion": { text: string };

  // Compositor surface writes (emitted by DefaultCompositor when bus provided)
  "compositor:write": { stream: string; text: string };

  // Generic keypress forwarding (control chars not handled by input-handler)
  "input:keypress": { key: string };

  // Raw input intercept (sync pipe: fired before any input processing).
  // Extensions set `consumed: true` to swallow input before it reaches the
  // PTY or mode handler — enables overlay UIs during foreground programs.
  "input:intercept": { data: string; consumed: boolean };

  // Stdout hold/release (ref-counted). While held, PTY output is not written
  // to stdout — enables overlay extensions to render without interference.
  "shell:stdout-hold": Record<string, never>;
  "shell:stdout-release": Record<string, never>;


  // Temporarily force PTY output visible even while agent is processing
  // (ref-counted). Used by tools like terminal_keys that need the user
  // to see the foreground program's response to injected keystrokes.
  "shell:stdout-show": Record<string, never>;
  "shell:stdout-hide": Record<string, never>;

  // Prompt redraw (sync pipe: extensions set handled=true to suppress).
  // kind="fresh" — \n to PTY, full precmd cycle, leaves a blank line.
  // kind="redraw" — in-place \e[9999~, no visual noise.
  "shell:redraw-prompt": {
    cwd: string;
    kind: "fresh" | "redraw";
    handled: boolean;
  };

  // Shell exec (async pipe: extension requests command execution in user's PTY)
  "shell:exec-request": {
    command: string;
    output: string;
    cwd: string;
    exitCode: number | null;
    done: boolean;
  };

  // Cross-cutting "config might have changed, repaint" signal.
  "config:changed": Record<string, never>;

  // Fires after all extensions (built-in + user) have activated.
  "core:extensions-loaded": { names: string[] };

  // Banner section collection (sync pipe: extensions contribute labeled items to startup banner)
  "banner:collect": {
    sections: Array<{ label: string; items: string[] }>;
    /** Name of the backend being launched. Extensions should gate per-backend sections on this rather than settings.defaultBackend. */
    activeBackend?: string;
  };

  // Autocomplete (sync pipe: extensions inspect buffer and append items)
  "autocomplete:request": {
    buffer: string;
    /** Parsed slash command name (e.g. "/backend"), or null if not a command. */
    command: string | null;
    /** Text after the command name (e.g. "clau" for "/backend clau"), or null. */
    commandArgs: string | null;
    items: { name: string; description: string }[];
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
  on<K extends keyof ShellEvents>(
    event: K,
    fn: Listener<ShellEvents[K]>,
  ): void {
    this.emitter.on(event, fn);
  }

  /** Unsubscribe from a fire-and-forget event. */
  off<K extends keyof ShellEvents>(
    event: K,
    fn: Listener<ShellEvents[K]>,
  ): void {
    this.emitter.off(event, fn);
  }

  /** Emit a fire-and-forget event. */
  emit<K extends keyof ShellEvents>(
    event: K,
    payload: ShellEvents[K],
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
  emitTransform<K extends keyof ShellEvents>(
    event: K,
    payload: ShellEvents[K],
  ): void {
    let transformed: ShellEvents[K];
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
  onPipe<K extends keyof ShellEvents>(
    event: K,
    fn: PipeListener<ShellEvents[K]>,
  ): void {
    let listeners = this.pipeListeners.get(event);
    if (!listeners) {
      listeners = [];
      this.pipeListeners.set(event, listeners);
    }
    listeners.push(fn);
  }

  /** Remove a transform listener from a pipeline event. */
  offPipe<K extends keyof ShellEvents>(
    event: K,
    fn: PipeListener<ShellEvents[K]>,
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
  emitPipe<K extends keyof ShellEvents>(
    event: K,
    payload: ShellEvents[K],
  ): ShellEvents[K] {
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
  offPipeAsync<K extends keyof ShellEvents>(
    event: K,
    fn: AsyncPipeListener<ShellEvents[K]>,
  ): void {
    const listeners = this.asyncPipeListeners.get(event);
    if (!listeners) return;
    const idx = listeners.indexOf(fn);
    if (idx !== -1) listeners.splice(idx, 1);
  }

  /** Register an async transform listener for a pipeline event. */
  onPipeAsync<K extends keyof ShellEvents>(
    event: K,
    fn: AsyncPipeListener<ShellEvents[K]>,
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
  async emitPipeAsync<K extends keyof ShellEvents>(
    event: K,
    payload: ShellEvents[K],
  ): Promise<ShellEvents[K]> {
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
