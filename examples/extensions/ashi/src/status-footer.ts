import { basename } from "node:path";
import { Container, Text, visibleWidth } from "@earendil-works/pi-tui";
import { theme } from "./theme.js";

interface StatusFields {
  model?: string;
  provider?: string;
  contextWindow?: number;
  cwd?: string;
  branch?: string;
  leaf?: number;
  tokens?: number;
  compactions?: number;
  thinking?: string;
  shellMode?: "off" | "on" | "private";
}

export class StatusFooter extends Container {
  private text: Text;
  private fields: StatusFields = {};
  private lastWidth = 0;

  constructor() {
    super();
    this.text = new Text("", 1, 0);
    this.addChild(this.text);
  }

  update(patch: Partial<StatusFields>): void {
    this.fields = { ...this.fields, ...patch };
    this.repaint(this.lastWidth);
  }

  render(width: number): string[] {
    if (width !== this.lastWidth) {
      this.lastWidth = width;
      this.repaint(width);
    }
    return super.render(width);
  }

  private repaint(width: number): void {
    const contentWidth = width > 0 ? Math.max(1, width - 2) : 0;
    const right = this.buildRight();
    const rightWidth = visibleWidth(right);
    const join = (left: string): string => {
      if (!right) return left;
      const leftWidth = visibleWidth(left);
      const gap = Math.max(1, contentWidth - leftWidth - rightWidth);
      return `${left}${" ".repeat(gap)}${right}`;
    };
    const full = this.buildLine("full");
    const fullFits = contentWidth === 0
      || visibleWidth(full) + (right ? rightWidth + 1 : 0) <= contentWidth;
    this.text.setText(fullFits ? join(full) : join(this.buildLine("basename")));
  }

  private buildRight(): string {
    const mode = this.fields.shellMode;
    if (mode === "on") return theme.fg("bashMode", "▸ shell");
    if (mode === "private") return theme.fg("bashModePrivate", "▸ shell · private");
    return "";
  }

  private buildLine(cwdMode: "full" | "basename"): string {
    const { model, provider, contextWindow, cwd, branch, leaf, tokens, compactions, thinking } = this.fields;
    const sep = theme.fg("dim", " | ");
    const parts: string[] = [];
    if (model) {
      const tail = provider ? theme.fg("muted", `@${provider}`) : "";
      const think = thinking ? theme.fg("muted", ` [${thinking}]`) : "";
      parts.push(`${theme.fg("accent", model)}${tail ? " " + tail : ""}${think}`);
    } else if (provider) {
      parts.push(theme.fg("muted", `@${provider}`));
    }
    if (cwd) parts.push(theme.fg("muted", formatCwd(cwd, cwdMode)));
    if (branch) parts.push(theme.fg("muted", `⎇ ${branch}`));
    if (leaf != null && leaf > 0) parts.push(theme.fg("muted", `#${leaf}`));
    if (tokens != null) {
      const tokStr = contextWindow ? `${fmtTokens(tokens)}/${fmtTokens(contextWindow)}` : fmtTokens(tokens);
      const pct = contextWindow ? ` ${theme.fg("dim", `${Math.round((tokens / contextWindow) * 100)}%`)}` : "";
      parts.push(`${theme.fg("muted", tokStr)}${pct}`);
    }
    if (compactions && compactions > 0) parts.push(theme.fg("muted", `⊟ ${compactions}`));
    return parts.length === 0 ? "" : parts.join(sep);
  }
}

function formatCwd(cwd: string, mode: "full" | "basename"): string {
  if (mode === "basename") return basename(cwd) || cwd;
  const home = process.env.HOME;
  if (home && cwd.startsWith(`${home}/`)) return `~/${cwd.slice(home.length + 1)}`;
  if (home && cwd === home) return "~";
  return cwd;
}

function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 100_000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}
