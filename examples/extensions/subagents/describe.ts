/** How a tool call is shown in a run's progress lines. */

/** Long absolute paths to their last two parts ("…/agent-teams/kb.py"): what a command does is in its arguments,
 *  which a 100-character cut used to drop behind the interpreter's and the script's paths (2026-11-28). */
export function shortenPaths(detail: string): string {
  return detail.replace(/(?<![\w.~])\/[^\s'"`]+/g, (p) => {
    const parts = p.split("/").filter(Boolean);
    return parts.length > 3 ? "…/" + parts.slice(-2).join("/") : p;
  });
}

/** At most 160 characters, cut in the middle so both the command and its last arguments stay. */
export function clipDetail(detail: string, max = 160): string {
  if (detail.length <= max) return detail;
  const head = Math.ceil((max - 1) * 0.6), tail = max - 1 - head;
  return detail.slice(0, head) + "…" + detail.slice(detail.length - tail);
}
