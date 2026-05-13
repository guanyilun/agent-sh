/**
 * Box frame component for bordered TUI panels.
 *
 * Follows the render(width) -> string[] protocol — pure function,
 * never writes to stdout. Supports multiple border styles and
 * optional title/footer sections with dividers.
 */
import { visibleLen, truncateToWidth, truncateAnsiToWidth } from "./ansi.js";
import { palette as p } from "./palette.js";

// ── Types ────────────────────────────────────────────────────────

export type BorderStyle = "rounded" | "square" | "double" | "heavy";

interface BorderChars {
  tl: string; // top-left
  tr: string; // top-right
  bl: string; // bottom-left
  br: string; // bottom-right
  h: string;  // horizontal
  v: string;  // vertical
  ml: string; // middle-left (├)
  mr: string; // middle-right (┤)
}

const BORDERS: Record<BorderStyle, BorderChars> = {
  rounded: { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│", ml: "├", mr: "┤" },
  square:  { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│", ml: "├", mr: "┤" },
  double:  { tl: "╔", tr: "╗", bl: "╚", br: "╝", h: "═", v: "║", ml: "╠", mr: "╣" },
  heavy:   { tl: "┏", tr: "┓", bl: "┗", br: "┛", h: "━", v: "┃", ml: "┣", mr: "┫" },
};

export interface BoxFrameOptions {
  /** Total width including borders. */
  width: number;
  /** Border style. Default "rounded". */
  style?: BorderStyle;
  /** Border color (ANSI escape). Default DIM. */
  borderColor?: string;
  /** Title text shown on the left of the top border. */
  title?: string;
  /** Title text shown on the right of the top border. */
  titleRight?: string;
  /** Footer lines shown below a divider, inside the box. */
  footer?: string[];
  /** Raw bg ANSI open code (e.g. "\x1b[48;2;40;50;40m"). When set, fills
   *  the frame interior with this bg and rewrites internal `\x1b[49m` /
   *  `\x1b[0m` resets so per-cell colors in content don't punch holes. */
  bgColor?: string;
}

// ── Public API ───────────────────────────────────────────────────

/**
 * Render content lines inside a bordered frame.
 *
 * @param content - Array of pre-rendered content lines (no border)
 * @param opts - Frame options
 * @returns Array of terminal-ready lines with borders
 */
export function renderBoxFrame(content: string[], opts: BoxFrameOptions): string[] {
  const { width: rawWidth, borderColor = p.dim } = opts;
  const width = Math.max(6, rawWidth);
  const style = opts.style ?? "rounded";
  const b = BORDERS[style];
  const bc = borderColor;
  const bg = opts.bgColor ?? "";

  // Content area width = total - 2 borders - 2 padding spaces
  const innerW = Math.max(1, width - 4);
  const output: string[] = [];

  // Top border (with optional left/right titles)
  if (opts.title || opts.titleRight) {
    // Budget: 2 corners + 1 minimum dash + space-padding around each title.
    // Truncate the left title first if combined widths overflow — titleRight
    // is typically short metadata (model name, stats) worth preserving.
    let title = opts.title;
    const rightVis = opts.titleRight ? visibleLen(opts.titleRight) + 2 : 0;
    const leftBudget = width - 2 - 1 - rightVis; // total - corners - min dash - right
    let leftVis = title ? visibleLen(title) + 2 : 0;
    if (title && leftVis > leftBudget) {
      const maxTitleVis = Math.max(1, leftBudget - 2);
      title = truncateAnsiToWidth(title, maxTitleVis);
      leftVis = visibleLen(title) + 2;
    }
    const leftPart = title ? `${p.reset} ${title} ${bc}` : "";
    const rightPart = opts.titleRight ? `${p.reset} ${opts.titleRight} ${bc}` : "";

    const dashCount = Math.max(1, width - 2 - leftVis - rightVis);
    output.push(
      paintBg(`${bc}${b.tl}${leftPart}${b.h.repeat(dashCount)}${rightPart}${b.tr}${p.reset}`, bg),
    );
  } else {
    output.push(paintBg(`${bc}${b.tl}${b.h.repeat(width - 2)}${b.tr}${p.reset}`, bg));
  }

  // Content lines
  for (const line of content) {
    output.push(paintBg(boxLine(line, innerW, b.v, bc), bg));
  }

  // Footer with divider
  if (opts.footer && opts.footer.length > 0) {
    output.push(paintBg(`${bc}${b.ml}${b.h.repeat(width - 2)}${b.mr}${p.reset}`, bg));
    for (const line of opts.footer) {
      output.push(paintBg(boxLine(line, innerW, b.v, bc), bg));
    }
  }

  // Bottom border
  output.push(paintBg(`${bc}${b.bl}${b.h.repeat(width - 2)}${b.br}${p.reset}`, bg));

  return output;
}

/** Wrap a line with a uniform bg, rewriting internal `\x1b[49m` (bg-default)
 *  and `\x1b[0m` (full-reset) so embedded colors don't punch through. */
function paintBg(line: string, bg: string): string {
  if (!bg) return line;
  const fixed = line
    .replaceAll("\x1b[49m", bg)
    .replaceAll("\x1b[0m", "\x1b[0m" + bg);
  return `${bg}${fixed}\x1b[49m`;
}

// ── Helpers ──────────────────────────────────────────────────────

function boxLine(text: string, innerW: number, v: string, bc: string): string {
  const textWidth = visibleLen(text);
  if (textWidth > innerW) {
    // Content is too wide — truncate to fit exactly
    const truncated = truncateToWidth(text, innerW);
    return `${bc}${v}${p.reset} ${truncated} ${bc}${v}${p.reset}`;
  }
  const pad = innerW - textWidth;
  return `${bc}${v}${p.reset} ${text}${" ".repeat(pad)} ${bc}${v}${p.reset}`;
}
