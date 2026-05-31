import chalk from "chalk";

/** Bundled dark palette, lifted from pi-coding-agent's dark.json. */
const VARS: Record<string, string> = {
  cyan: "#00d7ff",
  blue: "#5f87ff",
  green: "#b5bd68",
  red: "#cc6666",
  yellow: "#ffff00",
  gray: "#808080",
  dimGray: "#666666",
  darkGray: "#505050",
  accent: "#8abeb7",
  selectedBg: "#3a3a4a",
  userMsgBg: "#343541",
  toolPendingBg: "#282832",
  toolSuccessBg: "#283228",
  toolErrorBg: "#3c2828",
};

const RAW = {
  accent: "accent",
  border: "blue",
  borderAccent: "cyan",
  borderMuted: "darkGray",
  success: "green",
  error: "red",
  warning: "yellow",
  muted: "gray",
  dim: "dimGray",
  text: "",
  thinkingText: "gray",
  selectedBg: "selectedBg",
  userMessageBg: "userMsgBg",
  userMessageText: "",
  toolPendingBg: "toolPendingBg",
  toolSuccessBg: "toolSuccessBg",
  toolErrorBg: "toolErrorBg",
  toolTitle: "",
  toolOutput: "gray",
  mdHeading: "#f0c674",
  mdLink: "#81a2be",
  mdLinkUrl: "dimGray",
  mdCode: "accent",
  mdCodeBlock: "green",
  mdCodeBlockBorder: "gray",
  mdQuote: "gray",
  mdQuoteBorder: "gray",
  mdHr: "gray",
  mdListBullet: "accent",
  toolDiffAdded: "green",
  toolDiffRemoved: "red",
  toolDiffContext: "gray",
  bashMode: "yellow",
  bashModePrivate: "green",
} as const;

export type ThemeColor = keyof typeof RAW;

function resolve(v: string): string {
  if (v === "") return "";
  if (v.startsWith("#")) return v;
  const hex = VARS[v];
  if (!hex) throw new Error(`Unknown theme var: ${v}`);
  return hex;
}

function hexToRgb(hex: string): [number, number, number] {
  const c = hex.replace("#", "");
  return [parseInt(c.slice(0, 2), 16), parseInt(c.slice(2, 4), 16), parseInt(c.slice(4, 6), 16)];
}

function fgAnsi(hex: string): string {
  if (hex === "") return "\x1b[39m";
  const [r, g, b] = hexToRgb(hex);
  return `\x1b[38;2;${r};${g};${b}m`;
}

function bgAnsi(hex: string): string {
  if (hex === "") return "\x1b[49m";
  const [r, g, b] = hexToRgb(hex);
  return `\x1b[48;2;${r};${g};${b}m`;
}

class Theme {
  private fgCodes = new Map<ThemeColor, string>();
  private bgCodes = new Map<ThemeColor, string>();
  constructor() {
    for (const k of Object.keys(RAW) as ThemeColor[]) {
      const hex = resolve(RAW[k]);
      this.fgCodes.set(k, fgAnsi(hex));
      this.bgCodes.set(k, bgAnsi(hex));
    }
  }
  fg(color: ThemeColor, text: string): string { return `${this.fgCodes.get(color)}${text}\x1b[39m`; }
  bg(color: ThemeColor, text: string): string { return `${this.bgCodes.get(color)}${text}\x1b[49m`; }
  bgCode(color: ThemeColor): string { return this.bgCodes.get(color) ?? ""; }
  bold(text: string): string { return chalk.bold(text); }
  dim(text: string): string { return chalk.dim(text); }
  italic(text: string): string { return chalk.italic(text); }
  underline(text: string): string { return chalk.underline(text); }
  strikethrough(text: string): string { return chalk.strikethrough(text); }
}

export const theme = new Theme();

