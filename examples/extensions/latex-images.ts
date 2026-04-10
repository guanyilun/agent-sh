/**
 * LaTeX image overlay extension.
 *
 * Renders $$...$$ equations as inline terminal images using the same
 * pipeline as Emacs org-mode: latex → dvipng (or dvisvgm).
 *
 * Rendering: latex + dvipng (true LaTeX rendering, not approximations)
 * Display:   iTerm2 inline images or Kitty graphics protocol
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

// ── Terminal protocol detection ──────────────────────────────────

type ImageProtocol = "iterm2" | "kitty" | null;

function detectProtocol(): ImageProtocol {
  if (process.env.TERM_PROGRAM === "iTerm.app") return "iterm2";
  if (process.env.TERM_PROGRAM === "WezTerm") return "iterm2";
  if (process.env.KITTY_WINDOW_ID) return "kitty";
  if (process.env.TERM_PROGRAM === "ghostty") return "kitty";
  return null;
}

// ── Image display ────────────────────────────────────────────────

function displayImageITerm2(pngData: Buffer): string {
  const b64 = pngData.toString("base64");
  return `\x1b]1337;File=inline=1;size=${pngData.length};preserveAspectRatio=1:${b64}\x07`;
}

function displayImageKitty(pngData: Buffer): string {
  const b64 = pngData.toString("base64");
  const chunkSize = 4096;
  const chunks: string[] = [];

  for (let i = 0; i < b64.length; i += chunkSize) {
    const chunk = b64.slice(i, i + chunkSize);
    const isLast = i + chunkSize >= b64.length;
    if (i === 0) {
      chunks.push(`\x1b_Gf=100,t=d,a=T,m=${isLast ? 0 : 1};${chunk}\x1b\\`);
    } else {
      chunks.push(`\x1b_Gm=${isLast ? 0 : 1};${chunk}\x1b\\`);
    }
  }
  return chunks.join("");
}

function displayImage(pngData: Buffer, protocol: ImageProtocol): string {
  switch (protocol) {
    case "iterm2": return displayImageITerm2(pngData);
    case "kitty": return displayImageKitty(pngData);
    default: return "";
  }
}

// ── LaTeX rendering via latex + dvipng ───────────────────────────
//
// Same pipeline as Emacs org-mode:
//   1. Wrap equation in a minimal LaTeX document
//   2. latex → DVI
//   3. dvipng → PNG (tight crop, transparent bg, high DPI)

const LATEX_TEMPLATE = (equation: string, fg: string) => `
\\documentclass[border=1pt]{standalone}
\\usepackage{amsmath,amssymb,amsfonts}
\\usepackage{xcolor}
\\begin{document}
\\color[HTML]{${fg}}
$\\displaystyle ${equation}$
\\end{document}
`;

// Foreground color for equations (light gray for dark terminals)
const FG_COLOR = "d4d4d4";

let tmpDir: string | null = null;

function ensureTmpDir(): string {
  if (!tmpDir) {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "latex-img-"));
  }
  return tmpDir;
}

let renderCounter = 0;

function renderEquation(equation: string): Buffer | null {
  const dir = ensureTmpDir();
  const idx = renderCounter++;
  const texPath = path.join(dir, `eq${idx}.tex`);
  const dviPath = path.join(dir, `eq${idx}.dvi`);
  const pngPath = path.join(dir, `eq${idx}.png`);

  try {
    fs.writeFileSync(texPath, LATEX_TEMPLATE(equation, FG_COLOR));

    // latex → DVI
    execSync(
      `latex -interaction=nonstopmode -output-directory="${dir}" "${texPath}"`,
      { timeout: 10000, stdio: "pipe", cwd: dir },
    );

    // dvipng → PNG (tight crop, transparent background, high DPI)
    execSync(
      `dvipng -D 300 -T tight -bg Transparent --truecolor -o "${pngPath}" "${dviPath}"`,
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

// ── Stream buffering for $$...$$ ─────────────────────────────────

function processBuffer(
  text: string,
  protocol: ImageProtocol,
): { ready: string; pending: string } {
  let result = "";
  let i = 0;

  while (i < text.length) {
    const openIdx = text.indexOf("$$", i);
    if (openIdx === -1) {
      result += text.slice(i);
      return { ready: result, pending: "" };
    }

    const closeIdx = text.indexOf("$$", openIdx + 2);
    if (closeIdx === -1) {
      result += text.slice(i, openIdx);
      return { ready: result, pending: text.slice(openIdx) };
    }

    // Complete $$...$$ block
    const latex = text.slice(openIdx + 2, closeIdx).trim();
    result += text.slice(i, openIdx);

    // Render and display directly to stdout (bypass markdown renderer)
    const png = renderEquation(latex);
    if (png) {
      result += "\n";
      process.stdout.write("\n  " + displayImage(png, protocol));
    } else {
      result += `$$${latex}$$`;
    }

    i = closeIdx + 2;
  }

  return { ready: result, pending: "" };
}

// ── Extension entry point ────────────────────────────────────────

export default function activate({ bus }: ExtensionContext) {
  const protocol = detectProtocol();
  if (!protocol) {
    bus.emit("ui:error", {
      message: "latex-images: no supported image protocol (need iTerm2, WezTerm, Kitty, or Ghostty)",
    });
    return;
  }

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

  bus.emit("ui:info", { message: "latex-images: ready (latex + dvipng → " + protocol + ")" });

  let buffer = "";

  bus.onPipe("agent:response-chunk", (e) => {
    buffer += e.text;
    const { ready, pending } = processBuffer(buffer, protocol);
    buffer = pending;
    return { ...e, text: ready };
  });

  bus.onPipe("agent:response-done", (e) => {
    if (buffer) {
      bus.emitTransform("agent:response-chunk", { text: buffer });
      buffer = "";
    }
    return e;
  });

  process.on("exit", () => {
    if (tmpDir) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  });
}
