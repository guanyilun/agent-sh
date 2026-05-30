// pi-tui theme adapters: project ashi's renderer-agnostic ANSI palette (theme)
// into the theme objects pi-tui's Markdown / SelectList / Editor expect. These
// live in the pi-tui renderer so theme.ts stays substrate-level (palette only);
// a different renderer builds its own native theme objects from the same palette.

import { highlight, supportsLanguage } from "cli-highlight";
import type { EditorTheme, MarkdownTheme, SelectListTheme } from "@earendil-works/pi-tui";
import { theme } from "../../theme.js";

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
