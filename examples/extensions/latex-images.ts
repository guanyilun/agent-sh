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
let config = { dpi: 300, fgColor: "d4d4d4" };

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

let tmpDir: string | null = null;
let renderCounter = 0;

function ensureTmpDir(): string {
  if (!tmpDir) {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "latex-img-"));
  }
  return tmpDir;
}

function renderEquation(equation: string): Buffer | null {
  const dir = ensureTmpDir();
  const idx = renderCounter++;
  const texPath = path.join(dir, `eq${idx}.tex`);
  const dviPath = path.join(dir, `eq${idx}.dvi`);
  const pngPath = path.join(dir, `eq${idx}.png`);

  try {
    fs.writeFileSync(texPath, LATEX_TEMPLATE(equation, config.fgColor));

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
  if (!equationCache.has(equation)) {
    equationCache.set(equation, renderEquation(equation));
  }
  return equationCache.get(equation) ?? null;
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
    (bus.onPipe as unknown as (e: string, fn: (p: ContentPipe) => ContentPipe) => void)(
      "render:assistant-content",
      (payload) => {
        // Can't show images reliably → leave $$…$$ as text.
        if (!payload.images) return payload;
        return {
          ...payload,
          blocks: payload.blocks.flatMap((b) => (b.type === "text" ? splitEquations(b.text) : [b])),
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
