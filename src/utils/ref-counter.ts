/** Simple ref-counted counter. Increment/decrement never goes below zero. */
export class RefCounter {
  private count = 0;
  increment(): void { this.count++; }
  decrement(): void { this.count = Math.max(0, this.count - 1); }
  reset(): void { this.count = 0; }
  get active(): boolean { return this.count > 0; }
  get value(): number { return this.count; }
}
