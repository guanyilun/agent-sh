/** Display line for synthetic summary blocks and conversation_recall.
 *  The leading `#${id}` is the token the LLM uses to reference an
 *  entry when calling `recall:expand`. */
import type { Entry } from "./store.js";

interface SummaryPayload {
  sum?: string;
  why?: string;
}

export function formatEntryLine(e: Entry): string {
  const d = new Date(e.ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const p = e.payload as SummaryPayload;
  const sum = p.sum ?? `(${e.kind})`;
  const whyTag = p.why ? ` {${p.why.length > 80 ? p.why.slice(0, 77) + "..." : p.why}}` : "";
  return `#${e.id} [${stamp}] ${sum}${whyTag}`;
}
