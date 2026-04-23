import stringWidth from "string-width";

// ── ANSI escape code constants ────────────────────────────────

export const CYAN = "\x1b[36m";
export const DIM = "\x1b[2m";
export const YELLOW = "\x1b[33m";
export const GREEN = "\x1b[32m";
export const RED = "\x1b[31m";
export const GRAY = "\x1b[90m";
export const BOLD = "\x1b[1m";
export const RESET = "\x1b[0m";

// ── ANSI utility functions ───────────────────────────────────

// Reused across iterations. Segmenter construction is not free, and the API
// is pure (no per-call state) so a module-level instance is safe.
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Width of a single Unicode code point in terminal columns.
 *
 * For correct rendering of emoji clusters (ZWJ, flags, skin-tone, VS16)
 * prefer `clusterWidth` or `visibleLen`, which segment graphemes first.
 * This code-point-level primitive is kept for callers that iterate over
 * chars for wrap-detection purposes (e.g. CJK line-break rules).
 */
export function charWidth(codePoint: number): number {
  return stringWidth(String.fromCodePoint(codePoint));
}

/**
 * Width of one grapheme cluster in terminal columns. Handles ZWJ sequences,
 * regional-indicator flags, skin-tone modifiers, and VS16 emoji presentation.
 */
export function clusterWidth(cluster: string): number {
  return stringWidth(cluster);
}

/** Strip SGR (color/style) sequences from a string. */
function stripSGR(str: string): string {
  return str.replace(/\x1b\[[^m]*m/g, "");
}

/**
 * Measure visible string length in terminal columns.
 * Excludes SGR (color/style) sequences, and counts each grapheme cluster
 * (emoji, CJK, combining marks) as one terminal-visible unit.
 */
export function visibleLen(str: string): number {
  return stringWidth(stripSGR(str));
}

/**
 * Truncate a string to fit within `maxWidth` visible columns.
 * Iterates by grapheme cluster so emoji sequences (ZWJ, flags, VS16) are
 * kept intact rather than split mid-cluster. Appends `…` if truncated.
 */
export function truncateToWidth(str: string, maxWidth: number): string {
  const clean = stripSGR(str);
  if (maxWidth <= 0) return "";
  if (visibleLen(clean) <= maxWidth) return clean;
  if (maxWidth === 1) return "…";
  const target = maxWidth - 1;
  let width = 0;
  let out = "";
  for (const { segment } of GRAPHEME_SEGMENTER.segment(clean)) {
    const cw = clusterWidth(segment);
    if (width + cw > target) break;
    width += cw;
    out += segment;
  }
  if (out === "") return "…";
  return out + "…";
}

/** Truncate to visible width while preserving SGR sequences — use when
 *  input carries color/bold codes. `truncateToWidth` strips them. */
export function truncateAnsiToWidth(str: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (visibleLen(str) <= maxWidth) return str;
  if (maxWidth === 1) return "…";
  const target = maxWidth - 1;

  // Walk the string preserving SGR escapes in-place; buffer text between
  // escapes and segment it into graphemes to count width correctly.
  let width = 0;
  let out = "";
  let buf = "";
  let i = 0;
  const flushBuf = (): boolean => {
    if (!buf) return false;
    for (const { segment } of GRAPHEME_SEGMENTER.segment(buf)) {
      const cw = clusterWidth(segment);
      if (width + cw > target) {
        buf = "";
        return true; // budget exhausted
      }
      width += cw;
      out += segment;
    }
    buf = "";
    return false;
  };

  while (i < str.length) {
    if (str[i] === "\x1b" && str[i + 1] === "[") {
      const end = str.indexOf("m", i);
      if (end !== -1) {
        if (flushBuf()) break;
        out += str.slice(i, end + 1);
        i = end + 1;
        continue;
      }
    }
    const cp = str.codePointAt(i) ?? 0;
    const chLen = cp > 0xffff ? 2 : 1;
    buf += str.slice(i, i + chLen);
    i += chLen;
  }
  flushBuf();
  return out + "\x1b[0m…";
}

/**
 * Pad a string with spaces to fill `targetWidth` visible columns.
 */
export function padEndToWidth(str: string, targetWidth: number): string {
  const gap = targetWidth - visibleLen(str);
  return gap > 0 ? str + " ".repeat(gap) : str;
}

/** Strip all ANSI escape sequences (SGR, OSC, CSI, private mode) and carriage returns. */
export function stripAnsi(str: string): string {
  return str
    .replace(/\x1b\][^\x07]*\x07/g, "")        // OSC sequences
    .replace(/\x1b\[[^m]*m/g, "")                // SGR (color) sequences
    .replace(/\x1b\[\?[^a-zA-Z]*[a-zA-Z]/g, "") // private mode sequences
    .replace(/\x1b\[[^a-zA-Z]*[a-zA-Z]/g, "")   // CSI sequences
    .replace(/\r/g, "");                          // carriage returns
}
