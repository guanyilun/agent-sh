import { basename } from "node:path";
import type { TextView } from "./renderer.js";
import { theme } from "./theme.js";

interface StatusFields {
  model?: string;
  provider?: string;
  contextWindow?: number;
  cwd?: string;
  branch?: string;
  leaf?: number;
  tokens?: number;
  cacheRatio?: number;
  compactions?: number;
  thinking?: string;
  shellMode?: "off" | "on" | "private";
}

export class StatusFooter {
  private fields: StatusFields = {};

  constructor(
    private view: TextView,
    private measure: (text: string) => number,
  ) {
    this.refresh();
  }

  update(patch: Partial<StatusFields>): void {
    this.fields = { ...this.fields, ...patch };
    this.refresh();
  }

  private refresh(): void {
    this.view.setRenderFn((width) => [this.buildFooter(width)]);
  }

  private buildFooter(width: number): string {
    // width − 2: text node has paddingX=1 each side.
    const contentWidth = width > 0 ? Math.max(1, width - 2) : 0;
    const right = this.buildRight();
    const left = this.buildLine();
    if (!right) return left;
    const gap = Math.max(1, contentWidth - this.measure(left) - this.measure(right));
    return `${left}${" ".repeat(gap)}${right}`;
  }

  private buildRight(): string {
    const mode = this.fields.shellMode;
    if (mode === "on") return theme.fg("bashMode", "▸ shell");
    if (mode === "private") return theme.fg("bashModePrivate", "▸ shell · private");
    return "";
  }

  private buildLine(): string {
    const { model, provider, contextWindow, cwd, branch, leaf, tokens, cacheRatio, compactions, thinking } = this.fields;
    const sep = theme.fg("dim", " | ");
    const parts: string[] = [];
    if (model) {
      const tail = provider ? theme.fg("muted", `@${provider}`) : "";
      const think = thinking ? theme.fg("muted", ` [${thinking}]`) : "";
      parts.push(`${theme.fg("accent", model)}${tail ? " " + tail : ""}${think}`);
    } else if (provider) {
      parts.push(theme.fg("muted", `@${provider}`));
    }
    if (cwd) parts.push(theme.fg("muted", basename(cwd) || cwd));
    if (branch) parts.push(theme.fg("muted", `⎇ ${branch}`));
    if (leaf != null && leaf > 0) parts.push(theme.fg("muted", `#${leaf}`));
    if (tokens != null) {
      const tokStr = contextWindow ? `${fmtTokens(tokens)}/${fmtTokens(contextWindow)}` : fmtTokens(tokens);
      const pct = contextWindow ? ` ${theme.fg("dim", `${Math.round((tokens / contextWindow) * 100)}%`)}` : "";
      parts.push(`${theme.fg("muted", tokStr)}${pct}`);
    }
    if (cacheRatio != null) {
      const cachePct = cacheRatio * 100;
      const color = cachePct >= 80 ? "success" : cachePct >= 40 ? "warning" : "muted";
      parts.push(`${theme.fg("muted", "cache ")}${theme.fg(color, `${cachePct.toFixed(1)}%`)}`);
    }
    if (compactions && compactions > 0) parts.push(theme.fg("muted", `⊟ ${compactions}`));
    return parts.length === 0 ? "" : parts.join(sep);
  }
}

function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 100_000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}
