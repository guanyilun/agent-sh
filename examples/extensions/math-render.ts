/**
 * Unicode math transform extension.
 *
 * Demonstrates the content transform pipeline by replacing LaTeX-style
 * math notation in agent responses with Unicode equivalents:
 *
 *   $\alpha + \beta$  →  α + β
 *   $x^2 + y^2$      →  x² + y²
 *   $\sqrt{x}$       →  √x
 *   $\sum_{i=0}^{n}$ →  ∑ᵢ₌₀ⁿ
 *
 * This extension showcases:
 *   - onPipe transform: modifies text before any renderer sees it
 *   - Streaming buffer: holds back partial $...$ across chunk boundaries
 *   - Flush on response-done: drains remaining buffer when response ends
 *
 * Usage:
 *   agent-sh -e ./examples/extensions/math-render.ts
 */
import type { ExtensionContext } from "agent-sh/types";

// ── LaTeX → Unicode mappings ─────────────────────────────────────

const GREEK: Record<string, string> = {
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε",
  zeta: "ζ", eta: "η", theta: "θ", iota: "ι", kappa: "κ",
  lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", pi: "π",
  rho: "ρ", sigma: "σ", tau: "τ", upsilon: "υ", phi: "φ",
  chi: "χ", psi: "ψ", omega: "ω",
  Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Xi: "Ξ",
  Pi: "Π", Sigma: "Σ", Phi: "Φ", Psi: "Ψ", Omega: "Ω",
};

const SYMBOLS: Record<string, string> = {
  infty: "∞", infinity: "∞", pm: "±", mp: "∓",
  times: "×", div: "÷", cdot: "·", star: "⋆",
  leq: "≤", geq: "≥", neq: "≠", approx: "≈",
  equiv: "≡", sim: "∼", propto: "∝",
  sum: "∑", prod: "∏", int: "∫",
  partial: "∂", nabla: "∇", forall: "∀", exists: "∃",
  in: "∈", notin: "∉", subset: "⊂", supset: "⊃",
  subseteq: "⊆", supseteq: "⊇", cup: "∪", cap: "∩",
  emptyset: "∅", sqrt: "√",
  to: "→", rightarrow: "→", leftarrow: "←",
  Rightarrow: "⇒", Leftarrow: "⇐", leftrightarrow: "↔",
  langle: "⟨", rangle: "⟩",
  ldots: "…", cdots: "⋯", vdots: "⋮",
};

const SUPERSCRIPTS: Record<string, string> = {
  "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴",
  "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹",
  "+": "⁺", "-": "⁻", "=": "⁼", "(": "⁽", ")": "⁾",
  "n": "ⁿ", "i": "ⁱ", "k": "ᵏ", "x": "ˣ",
};

const SUBSCRIPTS: Record<string, string> = {
  "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄",
  "5": "₅", "6": "₆", "7": "₇", "8": "₈", "9": "₉",
  "+": "₊", "-": "₋", "=": "₌", "(": "₍", ")": "₎",
  "a": "ₐ", "e": "ₑ", "i": "ᵢ", "j": "ⱼ", "k": "ₖ",
  "n": "ₙ", "o": "ₒ", "r": "ᵣ", "x": "ₓ",
};

// ── Transform logic ──────────────────────────────────────────────

function toSuperscript(s: string): string {
  return [...s].map((c) => SUPERSCRIPTS[c] ?? c).join("");
}

function toSubscript(s: string): string {
  return [...s].map((c) => SUBSCRIPTS[c] ?? c).join("");
}

/** Transform a single LaTeX math expression (content between $...$). */
function transformMath(expr: string): string {
  let out = expr;

  // \command → symbol
  out = out.replace(/\\([a-zA-Z]+)/g, (_, cmd: string) => {
    return GREEK[cmd] ?? SYMBOLS[cmd] ?? `\\${cmd}`;
  });

  // \sqrt{...}  (already replaced \sqrt → √, now handle braces)
  out = out.replace(/√\{([^}]+)\}/g, "√($1)");
  out = out.replace(/√([a-zA-Z0-9])/g, "√$1");

  // Superscripts: ^{...} or ^x
  out = out.replace(/\^{([^}]+)}/g, (_, content: string) => toSuperscript(content));
  out = out.replace(/\^([a-zA-Z0-9])/g, (_, ch: string) => toSuperscript(ch));

  // Subscripts: _{...} or _x
  out = out.replace(/_{([^}]+)}/g, (_, content: string) => toSubscript(content));
  out = out.replace(/_([a-zA-Z0-9])/g, (_, ch: string) => toSubscript(ch));

  // \frac{a}{b} → a/b
  out = out.replace(/\\frac{([^}]+)}{([^}]+)}/g, "$1/$2");

  // Clean up remaining braces
  out = out.replace(/[{}]/g, "");

  return out;
}

// ── Extension entry point ────────────────────────────────────────
//
// Simple approach: transform all LaTeX commands in the raw stream.
// No delimiter detection needed — works on both code blocks and
// inline math because it's just text replacement.
//
// We buffer to handle partial commands at chunk boundaries
// (e.g. chunk ends with "\" and next chunk starts with "alpha").

export default function activate({ bus }: ExtensionContext) {
  let buffer = "";

  bus.onPipe("agent:response-chunk", (e) => {
    buffer += e.text;

    // Hold back if buffer ends with a backslash (partial command)
    // or ends mid-brace (partial ^{...} or _{...})
    const holdBack = findHoldBackPoint(buffer);
    const safe = buffer.slice(0, holdBack);
    buffer = buffer.slice(holdBack);

    return { ...e, text: transformMath(safe) };
  });

  bus.onPipe("agent:response-done", (e) => {
    if (buffer) {
      bus.emitTransform("agent:response-chunk", { text: transformMath(buffer) });
      buffer = "";
    }
    return e;
  });
}

/**
 * Find the point up to which we can safely transform.
 * Hold back from any trailing \ (incomplete command), or unclosed {.
 */
function findHoldBackPoint(text: string): number {
  // If ends with \, hold back from there (incomplete \command)
  if (text.endsWith("\\")) return text.length - 1;

  // If there's an unclosed { after the last }, hold back from the {
  const lastOpen = text.lastIndexOf("{");
  const lastClose = text.lastIndexOf("}");
  if (lastOpen > lastClose) return lastOpen;

  // If ends with ^ or _ (incomplete super/subscript), hold back
  if (text.endsWith("^") || text.endsWith("_")) return text.length - 1;

  return text.length; // everything is safe
}
