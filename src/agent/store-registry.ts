import type { Store } from "./store.js";

export class StoreRegistry {
  private stores = new Map<string, Store>();

  register(name: string, store: Store): void {
    if (this.stores.has(name)) {
      throw new Error(`store "${name}" is already registered`);
    }
    this.stores.set(name, store);
  }

  get(name: string): Store {
    const s = this.stores.get(name);
    if (!s) throw new Error(`no store registered for "${name}"`);
    return s;
  }

  has(name: string): boolean {
    return this.stores.has(name);
  }

  names(): string[] {
    return [...this.stores.keys()];
  }

  /** Test-only. */
  unregister(name: string): void {
    this.stores.delete(name);
  }
}
