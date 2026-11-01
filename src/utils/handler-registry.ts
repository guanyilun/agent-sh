/**
 * Named handler registry with Emacs-style advice.
 *
 * Built-in extensions register named handlers with `define`.
 * User extensions wrap them with `advise` — each advisor receives
 * `next` (the previous handler) and decides whether to call it.
 *
 *   registry.define("render:code-block", (lang, code) => highlight(lang, code));
 *
 *   registry.advise("render:code-block", (next, lang, code) => {
 *     if (lang === "latex") return renderLatex(code);
 *     return next(lang, code);  // call original
 *   });
 *
 * Internally, each handler is stored as a base function plus an ordered
 * list of advisors. `call` builds the chain on invocation, so advisors
 * can be added or removed at any time without closure entanglement.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

type HandlerFn = (...args: any[]) => any;
type Advisor = (next: HandlerFn, ...args: any[]) => any;

interface HandlerBase {
  fn: HandlerFn;
  previous?: HandlerBase;
  removed: boolean;
}

interface HandlerEntry {
  base?: HandlerBase;
  advisors: Advisor[];
}

/** The subset of HandlerRegistry methods available to extensions. */
export interface HandlerFunctions {
  define(name: string, fn: (...args: any[]) => any): void | (() => void);
  advise(name: string, advisor: (next: (...args: any[]) => any, ...args: any[]) => any): () => void;
  call(name: string, ...args: any[]): any;
  list(): string[];
  /** Base-presence check: advise() alone also creates a list() entry. */
  hasBase?(name: string): boolean;}

export class HandlerRegistry {
  private entries = new Map<string, HandlerEntry>();

  /**
   * Register a named handler. If one already exists, its base is replaced
   * but existing advisors are preserved. The returned disposer relinquishes
   * this base only, restoring the previous live base without removing advice.
   * Disposing an older definition never overwrites a newer one, nor can a
   * later disposal resurrect a definition whose owner has already gone away.
   */
  define(name: string, fn: HandlerFn): () => void {
    let entry = this.entries.get(name);
    if (!entry) {
      entry = { advisors: [] };
      this.entries.set(name, entry);
    }
    const base: HandlerBase = { fn, previous: entry.base, removed: false };
    entry.base = base;
    return () => {
      if (base.removed) return;
      base.removed = true;
      // Unlink even a buried definition, so a long-lived replacement does
      // not retain disposed extensions and their closures.
      if (entry.base === base) {
        entry.base = base.previous;
      } else {
        let newer = entry.base;
        while (newer && newer.previous !== base) newer = newer.previous;
        if (newer) newer.previous = base.previous;
      }
      base.previous = undefined;
      if (!entry.base && entry.advisors.length === 0 && this.entries.get(name) === entry) {
        this.entries.delete(name);
      }
    };
  }

  /**
   * Add an advisor to a named handler. The advisor receives `next`
   * (the rest of the chain) and all original arguments.
   *
   * - Call `next(...args)` to invoke the rest of the chain
   * - Don't call `next` to replace entirely (override)
   * - Call `next` conditionally to wrap (around)
   *
   * Advisors run outermost-first (last added = outermost).
   * Returns an unadvise function that cleanly removes this advisor.
   */
  advise(name: string, advisor: Advisor): () => void {
    let entry = this.entries.get(name);
    if (!entry) {
      entry = { advisors: [] };
      this.entries.set(name, entry);
    }
    entry.advisors.push(advisor);

    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      const e = this.entries.get(name);
      if (!e) return;
      const idx = e.advisors.indexOf(advisor);
      if (idx !== -1) e.advisors.splice(idx, 1);
      if (!e.base && e.advisors.length === 0) this.entries.delete(name);
    };
  }

  /**
   * Call a named handler. Builds the advisor chain on each call:
   * outermost advisor wraps the next, down to the base handler.
   * Returns undefined if no handler is registered.
   */
  call(name: string, ...args: any[]): any {
    const entry = this.entries.get(name);
    if (!entry) return undefined;

    // Build chain: base ← advisor[0] ← advisor[1] ← ... ← advisor[n-1]
    let fn: HandlerFn = entry.base?.fn ?? (() => undefined);
    for (const advisor of entry.advisors) {
      const next = fn;
      fn = (...a: any[]) => advisor(next, ...a);
    }
    return fn(...args);
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  /** True only when a base handler is present. advise() alone also creates an entry
   *  with advisors but no base, so has()/list() wrongly pass as capability checks. */
  hasBase(name: string): boolean {
    return this.entries.get(name)?.base !== undefined;
  }

  /** Names of all registered handlers — for diagnostics/introspection. */
  list(): string[] {
    return [...this.entries.keys()];
  }
}
