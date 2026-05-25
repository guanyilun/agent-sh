import chalk from "chalk";
import { highlight, supportsLanguage } from "cli-highlight";
import type { EditorTheme, MarkdownTheme, SelectListTheme } from "@earendil-works/pi-tui";

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
  italic(text: string): string { return chalk.italic(text); }
  underline(text: string): string { return chalk.underline(text); }
  strikethrough(text: string): string { return chalk.strikethrough(text); }
}

export const theme = new Theme();

export function markdownTheme(): MarkdownTheme {
  return {
    heading: (t) => theme.fg("mdHeading", t),
    link: (t) => theme.fg("mdLink", t),
    linkUrl: (t) => theme.fg("mdLinkUrl", t),
    code: (t) => theme.fg("mdCode", t),
    codeBlock: (t) => theme.fg("mdCodeBlock", t),
    codeBlockBorder: (t) => theme.fg("mdCodeBlockBorder", t),
    quote: (t) => theme.fg("mdQuote", t),
    quoteBorder: (t) => theme.fg("mdQuoteBorder", t),
    hr: (t) => theme.fg("mdHr", t),
    listBullet: (t) => theme.fg("mdListBullet", t),
    bold: (t) => theme.bold(t),
    italic: (t) => theme.italic(t),
    underline: (t) => theme.underline(t),
    strikethrough: (t) => theme.strikethrough(t),
    highlightCode: (src: string, lang?: string): string[] => {
      const validLang = lang && supportsLanguage(lang) ? lang : undefined;
      if (!validLang) return src.split("\n").map((l) => theme.fg("mdCodeBlock", l));
      try {
        return highlight(src, { language: validLang, ignoreIllegals: true }).split("\n");
      } catch {
        return src.split("\n").map((l) => theme.fg("mdCodeBlock", l));
      }
    },
  };
}

export function selectListTheme(): SelectListTheme {
  return {
    selectedPrefix: (t) => theme.fg("accent", t),
    selectedText: (t) => theme.fg("accent", t),
    description: (t) => theme.fg("muted", t),
    scrollInfo: (t) => theme.fg("muted", t),
    noMatch: (t) => theme.fg("muted", t),
  };
}

export function editorTheme(): EditorTheme {
  return {
    borderColor: (t) => theme.fg("borderMuted", t),
    selectList: selectListTheme(),
  };
}

