/** Recently finished spawn_agent subagents, kept so `resume` can continue or re-read them. */

export interface FinishedSubagent<Spec> {
  id: string;
  spec: Spec;
  /** The conversation so far, passed back as the next run's history. */
  history: unknown[];
  /** The full final answer (a fan-out result may show it clipped). */
  text: string;
}

export class FinishedSubagents<Spec> {
  private entries = new Map<string, FinishedSubagent<Spec>>();
  private seq = 0;
  constructor(private readonly limit = 20) {}

  nextId(): string {
    return `s${++this.seq}`;
  }

  add(entry: FinishedSubagent<Spec>): void {
    this.entries.delete(entry.id);
    this.entries.set(entry.id, entry);
    // Oldest first: drop beyond the limit so long sessions don't keep every transcript.
    while (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value!);
  }

  get(id: string): FinishedSubagent<Spec> | undefined {
    return this.entries.get(id);
  }

  ids(): string[] {
    return [...this.entries.keys()];
  }
}

/** Keep the head and the tail (where a stop note sits), marking what was cut. */
export function clipMiddle(text: string, max: number, note: string): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 2 / 3);
  const tail = max - head;
  return `${text.slice(0, head)}\n\n… [${text.length - max} chars omitted; ${note}] …\n\n${text.slice(-tail)}`;
}
