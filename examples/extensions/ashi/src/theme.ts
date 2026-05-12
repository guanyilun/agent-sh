import chalk from "chalk";
import { highlight, supportsLanguage } from "cli-highlight";
import type { EditorTheme, MarkdownTheme, SelectListTheme } from "@earendil-works/pi-tui";

const muted = chalk.gray;
const dim = chalk.gray.dim;
const accent = chalk.cyan;
const error = chalk.red;
const warning = chalk.yellow;
const ok = chalk.green;
const heading = chalk.bold.cyan;
const link = chalk.cyan.underline;
const code = chalk.yellow;
const codeBlock = (t: string) => t;
const codeBlockBorder = chalk.gray;
const quote = chalk.italic.gray;
const quoteBorder = chalk.gray;
const listBullet = chalk.cyan;

export const c = {
  muted,
  dim,
  accent,
  error,
  warning,
  ok,
  heading,
  borderMuted: chalk.gray,
  borderAccent: chalk.cyan,
  user: chalk.green,
  assistant: chalk.white,
  toolName: chalk.cyan,
  toolDetail: chalk.gray,
};

export function markdownTheme(): MarkdownTheme {
  return {
    heading,
    link,
    linkUrl: chalk.gray,
    code,
    codeBlock,
    codeBlockBorder,
    quote,
    quoteBorder,
    hr: chalk.gray,
    listBullet,
    bold: chalk.bold,
    italic: chalk.italic,
    underline: chalk.underline,
    strikethrough: chalk.strikethrough,
    highlightCode: (src: string, lang?: string): string[] => {
      const validLang = lang && supportsLanguage(lang) ? lang : undefined;
      if (!validLang) return src.split("\n").map((l) => chalk.gray(l));
      try {
        return highlight(src, { language: validLang, ignoreIllegals: true }).split("\n");
      } catch {
        return src.split("\n").map((l) => chalk.gray(l));
      }
    },
  };
}

const selectListTheme: SelectListTheme = {
  selectedPrefix: accent,
  selectedText: accent,
  description: muted,
  scrollInfo: muted,
  noMatch: muted,
};

export function editorTheme(): EditorTheme {
  return {
    borderColor: chalk.gray,
    selectList: selectListTheme,
  };
}
