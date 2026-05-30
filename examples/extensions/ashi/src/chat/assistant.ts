// Assistant message: streaming markdown. On finalize, settled text is projected
// into markdown + inline display-math ($$…$$) segments; rebuild-from-store runs
// the same path so an equation renders identically live and rehydrated.

import type { ContainerView, MarkdownView, RenderNode, RenderNodes } from "../renderer.js";

/** Render a LaTeX source string to a display node, or null when no toolchain is
 *  available or rendering failed. */
export type EquationRenderer = (latexSrc: string) => RenderNode | null;

type LatexSegment = { type: "text"; value: string } | { type: "latex"; value: string };

/** Split assistant text into ordered markdown / display-math segments. Unclosed
 *  delimiters stay as text. Width-independent — safe to run once. */
function segmentLatex(text: string): LatexSegment[] {
  const segments: LatexSegment[] = [];
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf("$$", i);
    if (open === -1) { segments.push({ type: "text", value: text.slice(i) }); break; }
    const close = text.indexOf("$$", open + 2);
    if (close === -1) { segments.push({ type: "text", value: text.slice(i) }); break; }
    if (open > i) segments.push({ type: "text", value: text.slice(i, open) });
    segments.push({ type: "latex", value: text.slice(open + 2, close).trim() });
    i = close + 2;
  }
  return segments;
}

export class AssistantMessage {
  readonly node: RenderNode;
  private container: ContainerView;
  private md: MarkdownView;
  private buffer = "";

  constructor(private nodes: RenderNodes, private renderEquation?: EquationRenderer) {
    this.container = nodes.container();
    this.md = nodes.markdown({ paddingX: 1 });
    this.container.addChild(nodes.spacer(1));
    this.container.addChild(this.md.node);
    this.node = this.container.node;
  }

  appendText(t: string): void {
    this.buffer += t;
    this.md.setText(this.buffer);
  }

  appendCodeBlock(language: string, code: string): void {
    const prefix = this.buffer && !this.buffer.endsWith("\n") ? "\n" : "";
    this.buffer += `${prefix}\`\`\`${language}\n${code}\n\`\`\`\n`;
    this.md.setText(this.buffer);
  }

  finalize(): void {
    if (this.buffer === "") this.buffer = " ";
    if (this.renderEquation && this.buffer.includes("$$")) {
      this.rebuildWithEquations();
    } else {
      this.md.setText(this.buffer);
    }
  }

  private rebuildWithEquations(): void {
    const segments = segmentLatex(this.buffer);
    if (!segments.some((s) => s.type === "latex")) {
      this.md.setText(this.buffer);
      return;
    }
    this.container.clear();
    this.container.addChild(this.nodes.spacer(1));
    for (const seg of segments) {
      if (seg.type === "text") {
        if (seg.value.trim()) {
          const m = this.nodes.markdown({ paddingX: 1 });
          m.setText(seg.value);
          this.container.addChild(m.node);
        }
      } else {
        // Fall back to the raw source if the toolchain is missing or fails.
        const eq = this.renderEquation!(seg.value);
        if (eq) {
          this.container.addChild(eq);
        } else {
          const m = this.nodes.markdown({ paddingX: 1 });
          m.setText(`$$${seg.value}$$`);
          this.container.addChild(m.node);
        }
      }
    }
  }

  hasContent(): boolean {
    return this.buffer.trim().length > 0;
  }
}
