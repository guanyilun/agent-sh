import { Container, Text } from "@earendil-works/pi-tui";
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
}

export class StatusFooter extends Container {
  private text: Text;
  private fields: StatusFields = {};

  constructor() {
    super();
    this.text = new Text("", 1, 0);
    this.addChild(this.text);
  }

  update(patch: Partial<StatusFields>): void {
    this.fields = { ...this.fields, ...patch };
    this.repaint();
  }

  private repaint(): void {
    const { model, provider, contextWindow, cwd, branch, leaf, tokens, compactions } = this.fields;
    const sep = theme.fg("dim", " | ");
    const parts: string[] = [];
    if (model) {
      const tail = provider ? theme.fg("muted", `@${provider}`) : "";
      parts.push(`${theme.fg("accent", model)}${tail ? " " + tail : ""}`);
    } else if (provider) {
      parts.push(theme.fg("muted", `@${provider}`));
    }
    if (cwd) parts.push(theme.fg("muted", shortenCwd(cwd)));
    if (branch) parts.push(theme.fg("muted", `⎇ ${branch}`));
    if (leaf != null && leaf > 0) parts.push(theme.fg("muted", `#${leaf}`));
    if (tokens != null) {
      const tokStr = contextWindow ? `${fmtTokens(tokens)}/${fmtTokens(contextWindow)}` : fmtTokens(tokens);
      const pct = contextWindow ? ` ${theme.fg("dim", `${Math.round((tokens / contextWindow) * 100)}%`)}` : "";
      parts.push(`${theme.fg("muted", tokStr)}${pct}`);
    }
    if (compactions && compactions > 0) parts.push(theme.fg("muted", `⊟ ${compactions}`));
    this.text.setText(parts.length === 0 ? "" : parts.join(sep));
  }
}

function shortenCwd(cwd: string): string {
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
