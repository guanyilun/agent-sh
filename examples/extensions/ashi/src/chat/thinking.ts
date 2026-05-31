// Hidden clears the block but keeps the buffer so a toggle restores it.
import type { ContainerView, MarkdownView, RenderNode, RenderNodes } from "../renderer.js";
import { theme } from "../theme.js";

const thinkingColor = (t: string): string => theme.dim(theme.italic(theme.fg("thinkingText", t)));

export class ThinkingBlock {
  readonly node: RenderNode;
  private container: ContainerView;
  private md: MarkdownView;
  private buffer = "";
  private hidden = false;

  constructor(private nodes: RenderNodes) {
    this.container = nodes.container();
    this.md = nodes.markdown({ paddingX: 1, color: thinkingColor });
    this.container.addChild(nodes.spacer(1));
    this.container.addChild(this.md.node);
    this.node = this.container.node;
  }

  appendText(t: string): void {
    this.buffer += t;
    if (!this.hidden) this.md.setText(this.buffer);
  }

  finalize(): void {
    if (this.buffer === "") this.buffer = " ";
    if (!this.hidden) this.md.setText(this.buffer);
  }

  setHidden(hidden: boolean): void {
    if (hidden === this.hidden) return;
    this.hidden = hidden;
    this.container.clear();
    if (hidden) return;
    this.container.addChild(this.nodes.spacer(1));
    this.md = this.nodes.markdown({ paddingX: 1, color: thinkingColor });
    this.md.setText(this.buffer);
    this.container.addChild(this.md.node);
  }
}
