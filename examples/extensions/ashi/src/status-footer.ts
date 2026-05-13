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
    const parts: string[] = [];
    const { model, provider, contextWindow, cwd, branch, leaf, tokens, compactions } = this.fields;
    if (model) parts.push(model);
    if (provider) parts.push(provider);
    if (cwd) parts.push(shortenCwd(cwd));
    if (branch) parts.push(branch);
    if (leaf != null && leaf > 0) parts.push(`#${leaf}`);
    if (tokens != null) {
      parts.push(contextWindow ? `${fmtTokens(tokens)}/${fmtTokens(contextWindow)}` : fmtTokens(tokens));
    }
    if (compactions && compactions > 0) parts.push(`${compactions} compaction${compactions === 1 ? "" : "s"}`);
    const line = parts.length === 0 ? "" : theme.fg("muted", parts.join("  ·  "));
    this.text.setText(line);
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
