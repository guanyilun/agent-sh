export class Semaphore {
  private waiting: (() => void)[] = [];
  constructor(private free: number) {}

  acquire(): Promise<void> {
    if (this.free > 0) { this.free--; return Promise.resolve(); }
    return new Promise(resolve => this.waiting.push(resolve));
  }

  release(): void {
    const next = this.waiting.shift();
    if (next) next(); else this.free++;
  }
}
