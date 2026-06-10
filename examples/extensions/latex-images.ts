/**
 * LaTeX image overlay extension.
 *
 * Renders $$...$$ equations as inline terminal images using the same
 * pipeline as Emacs org-mode: latex → dvipng.
 *
 * Uses the content transform pipeline (createBlockTransform + ContentBlock)
 * so the extension just defines delimiters and a transform function —
 * no manual buffering, no process.stdout hacks.
 *
 * Requirements:
 *   - latex and dvipng (typically from TeX Live: `brew install --cask mactex`)
 *   - iTerm2, WezTerm, Kitty, or Ghostty terminal
 *
 * Usage:
 *   agent-sh -e ./examples/extensions/latex-images.ts
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionContext } from "agent-sh/types";

// Settings loaded in activate() via ctx.getExtensionSettings
// inlineScale: inline math font vs ~1 em of text (1.0 ≈ text, <1 smaller).
let config = { dpi: 300, fgColor: "d4d4d4", inlineScale: 1.0 };

let magickBin: string | null = null;

/** Encode PNG as iTerm2 or Kitty inline image escape sequence. */
function encodeImage(data: Buffer): string {
  const b64 = data.toString("base64");
  if (process.env.TERM_PROGRAM === "iTerm.app" || process.env.TERM_PROGRAM === "WezTerm") {
    return `\x1b]1337;File=inline=1;size=${data.length};preserveAspectRatio=1:${b64}\x07`;
  }
  if (process.env.KITTY_WINDOW_ID || process.env.TERM_PROGRAM === "ghostty") {
    const chunks: string[] = [];
    for (let i = 0; i < b64.length; i += 4096) {
      const chunk = b64.slice(i, i + 4096);
      const isLast = i + 4096 >= b64.length;
      chunks.push(i === 0
        ? `\x1b_Gf=100,t=d,a=T,m=${isLast ? 0 : 1};${chunk}\x1b\\`
        : `\x1b_Gm=${isLast ? 0 : 1};${chunk}\x1b\\`);
    }
    return chunks.join("");
  }
  return "";
}

// ── LaTeX rendering via latex + dvipng ───────────────────────────

const LATEX_TEMPLATE = (equation: string, fg: string) => `
\\documentclass[border=1pt]{standalone}
\\usepackage{amsmath,amssymb,amsfonts}
\\usepackage{xcolor}
\\begin{document}
\\color[HTML]{${fg}}
$\\displaystyle ${equation}$
\\end{document}
`;

// Inline equations: text-style (no \displaystyle) so sizing matches a text line.
const LATEX_INLINE_TEMPLATE = (equation: string, fg: string) => `
\\documentclass[border=1pt]{standalone}
\\usepackage{amsmath,amssymb,amsfonts}
\\usepackage{xcolor}
\\begin{document}
\\color[HTML]{${fg}}
$ ${equation} $
\\end{document}
`;

let tmpDir: string | null = null;
let renderCounter = 0;

function ensureTmpDir(): string {
  if (!tmpDir) {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "latex-img-"));
  }
  return tmpDir;
}

function renderEquation(
  equation: string,
  template: (eq: string, fg: string) => string,
): Buffer | null {
  const dir = ensureTmpDir();
  const idx = renderCounter++;
  const texPath = path.join(dir, `eq${idx}.tex`);
  const dviPath = path.join(dir, `eq${idx}.dvi`);
  const pngPath = path.join(dir, `eq${idx}.png`);

  try {
    fs.writeFileSync(texPath, template(equation, config.fgColor));

    execSync(
      `latex -interaction=nonstopmode -output-directory="${dir}" "${texPath}"`,
      { timeout: 10000, stdio: "pipe", cwd: dir },
    );

    execSync(
      `dvipng -D ${config.dpi} -T tight -bg Transparent --truecolor -o "${pngPath}" "${dviPath}"`,
      { timeout: 10000, stdio: "pipe" },
    );

    return fs.readFileSync(pngPath);
  } catch (err) {
    if (process.env.DEBUG) {
      const msg = err instanceof Error ? (err as any).stderr?.toString() || err.message : String(err);
      process.stderr.write(`[latex-images] render failed: ${msg}\n`);
    }
    return null;
  }
}

const equationCache = new Map<string, Buffer | null>();
function renderEquationCached(equation: string): Buffer | null {
  const key = `d:${equation}`;
  if (!equationCache.has(key)) {
    equationCache.set(key, renderEquation(equation, LATEX_TEMPLATE));
  }
  return equationCache.get(key) ?? null;
}

// 1 TeX pt = 1/72.27 inch; standalone's default body font is 10pt.
const PT_PER_INCH = 72.27;

// Pad each equation's height up to a shared ~1 em reference (transparent, centered)
// so short and tall expressions render at the same font — only their heights differ.
// Cols are derived downstream from this padded height. No-op for already-tall content.
function normalizeInlineHeight(buf: Buffer): Buffer {
  if (!magickBin) return buf;
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  const emPx = (config.dpi * 10) / PT_PER_INCH;
  const scale = config.inlineScale > 0 ? config.inlineScale : 1;
  const targetH = Math.round(emPx / scale);
  if (h >= targetH) return buf;
  const dir = ensureTmpDir();
  const idx = renderCounter++;
  const inPath = path.join(dir, `pad${idx}-in.png`);
  const outPath = path.join(dir, `pad${idx}-out.png`);
  try {
    fs.writeFileSync(inPath, buf);
    execSync(
      `${magickBin} "${inPath}" -background none -gravity center -extent ${w}x${targetH} "${outPath}"`,
      { timeout: 10000, stdio: "pipe" },
    );
    return fs.readFileSync(outPath);
  } catch {
    return buf;
  }
}

function renderInlineCached(equation: string): Buffer | null {
  const key = `i:${equation}`;
  if (!equationCache.has(key)) {
    const png = renderEquation(equation, LATEX_INLINE_TEMPLATE);
    equationCache.set(key, png ? normalizeInlineHeight(png) : null);
  }
  return equationCache.get(key) ?? null;
}

const EQ_DELIM = "$$";

type Block =
  | { type: "text"; text: string }
  | { type: "image"; data: Buffer }
  | { type: "code-block"; language: string; code: string };
type ContentPipe = { blocks: Block[]; images?: boolean };

function splitEquations(text: string): Block[] {
  const out: Block[] = [];
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf(EQ_DELIM, i);
    if (open === -1) {
      const rest = text.slice(i);
      if (rest) out.push({ type: "text", text: rest });
      break;
    }
    const close = text.indexOf(EQ_DELIM, open + EQ_DELIM.length);
    if (close === -1) { out.push({ type: "text", text: text.slice(i) }); break; }
    if (open > i) out.push({ type: "text", text: text.slice(i, open) });
    const png = renderEquationCached(text.slice(open + EQ_DELIM.length, close).trim());
    out.push(png ? { type: "image", data: png } : { type: "text", text: text.slice(open, close + EQ_DELIM.length) });
    i = close + EQ_DELIM.length;
  }
  return out;
}

// ── Inline math ($…$) ────────────────────────────────────────────

// KaTeX-style `$…$` rules so prose/currency don't false-match: no space after the
// opening `$`; no space before the closing `$` and no digit after it; one line; \$.
function matchInline(text: string, open: number): { eq: string; end: number } | null {
  if (open + 1 >= text.length || /\s/.test(text[open + 1]!)) return null;
  for (let j = open + 1; j < text.length; j++) {
    const ch = text[j]!;
    if (ch === "\n") return null;
    if (ch === "\\") { j++; continue; }
    if (ch !== "$") continue;
    if (/\s/.test(text[j - 1]!)) continue;
    if (/[0-9]/.test(text[j + 1] ?? "")) continue;
    const eq = text.slice(open + 1, j);
    return eq.trim() === "" ? null : { eq, end: j + 1 };
  }
  return null;
}

// Replace inline `$…$` with `\x01LI:<id>\x01` sentinels; leaves escapes and inline
// code spans untouched, and falls back to literal text when register() returns null.
function replaceInline(text: string, register: (eq: string) => number | null): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === "\\") { out += text.slice(i, i + 2); i += 2; continue; }
    if (c === "`") {
      const end = text.indexOf("`", i + 1);
      if (end === -1) { out += text.slice(i); break; }
      out += text.slice(i, end + 1); i = end + 1; continue;
    }
    if (c === "$" && text[i + 1] !== "$") {
      const m = matchInline(text, i);
      if (m) {
        const id = register(m.eq);
        out += id === null ? text.slice(i, m.end) : `\x01LI:${id}\x01`;
        i = m.end;
        continue;
      }
    }
    out += c; i++;
  }
  return out;
}

// ── Extension entry point ────────────────────────────────────────

export default function activate(ctx: ExtensionContext) {
  const { bus } = ctx;

  // Load settings: ~/.agent-sh/settings.json → "latex-images": { dpi, fgColor }
  config = ctx.getExtensionSettings("latex-images", config);

  // Check for latex + dvipng
  try {
    execSync("latex --version", { stdio: "ignore", timeout: 3000 });
    execSync("dvipng --version", { stdio: "ignore", timeout: 3000 });
  } catch {
    bus.emit("ui:error", {
      message: "latex-images: latex and dvipng required (brew install --cask mactex)",
    });
    return;
  }

  // ImageMagick is optional; only used to shrink inline glyphs (config.inlineScale).
  for (const bin of ["magick", "convert"]) {
    try {
      execSync(`${bin} --version`, { stdio: "ignore", timeout: 3000 });
      magickBin = bin;
      break;
    } catch { /* not installed */ }
  }

  ctx.define("latex:render-equation", (equation: string): Buffer | null => renderEquationCached(equation));

  if (ctx.shell) {
    // Shell streams output, so it buffers $$ spanning chunks; finalized-content
    // renderers (below) get whole blocks instead.
    ctx.shell.createBlockTransform({
      open: EQ_DELIM,
      close: EQ_DELIM,
      transform(latex: string) {
        const png = renderEquationCached(latex);
        return png ? { type: "image" as const, data: png } : null;
      },
    });

    ctx.advise("render:code-block", (next, language: string, code: string, width: number) => {
      if (language !== "latex" && language !== "tex") return next(language, code, width);
      const png = renderEquationCached(code);
      if (!png) return next(language, code, width);
      ctx.call("render:image", png);
    });
  } else {
    // Cache the id per equation so each image is registered (and transmitted) once.
    const inlineIds = new Map<string, number>();
    const registerInline = (eq: string): number | null => {
      const cached = inlineIds.get(eq);
      if (cached !== undefined) return cached;
      const png = renderInlineCached(eq);
      if (!png) return null;
      const id = ctx.call("ashi:inline-image:register", png) as number | null;
      if (typeof id === "number") inlineIds.set(eq, id);
      return typeof id === "number" ? id : null;
    };

    (bus.onPipe as unknown as (e: string, fn: (p: ContentPipe) => ContentPipe) => void)(
      "render:assistant-content",
      (payload) => {
        // Can't show images reliably → leave $$…$$ as text.
        if (!payload.images) return payload;
        const canInline = ctx.list().includes("ashi:inline-image:register");
        return {
          ...payload,
          blocks: payload.blocks.flatMap((b) => {
            if (b.type !== "text") return [b];
            return splitEquations(b.text).map((blk) =>
              blk.type === "text" && canInline
                ? { type: "text" as const, text: replaceInline(blk.text, registerInline) }
                : blk,
            );
          }),
        };
      },
    );
  }

  process.on("exit", () => {
    if (tmpDir) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  });
}
