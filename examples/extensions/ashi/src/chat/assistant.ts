import type { ContainerView, MarkdownView, RenderNode, RenderNodes } from "../renderer.js";

export type RenderBlock =
  | { type: "text"; text: string }
  | { type: "code-block"; language: string; code: string }
  | { type: "image"; data: Buffer };

export type ContentTransform = (blocks: RenderBlock[]) => RenderBlock[];

const stripTrailing = (s: string): string => s.replace(/\s+$/, "");

export class AssistantMessage {
  readonly node: RenderNode;
  private container: ContainerView;
  private md: MarkdownView;
  private buffer = "";

  constructor(private nodes: RenderNodes, private transform: ContentTransform = (b) => b) {
    this.container = nodes.container();
    this.md = nodes.markdown({ paddingX: 1, bullet: true });
    this.container.addChild(nodes.spacer(1));
    this.container.addChild(this.md.node);
    this.node = this.container.node;
  }

  appendText(t: string): void {
    this.buffer += t;
    this.md.setText(stripTrailing(this.buffer));
  }

  appendCodeBlock(language: string, code: string): void {
    const prefix = this.buffer && !this.buffer.endsWith("\n") ? "\n" : "";
    this.buffer += `${prefix}\`\`\`${language}\n${code}\n\`\`\`\n`;
    this.md.setText(stripTrailing(this.buffer));
  }

  finalize(): void {
    if (this.buffer === "") this.buffer = " ";
    const blocks = this.transform([{ type: "text", text: this.buffer }]);
    if (blocks.every((b) => b.type === "text")) {
      this.md.setText(stripTrailing(this.buffer));
      return;
    }
    this.rebuild(blocks);
  }

  private rebuild(blocks: RenderBlock[]): void {
    this.container.clear();
    this.container.addChild(this.nodes.spacer(1));
    for (const block of blocks) {
      if (block.type === "image") {
        const img = this.nodes.image(block.data);
        if (img) this.container.addChild(img);
      } else if (block.type === "code-block") {
        const m = this.nodes.markdown({ paddingX: 1 });
        m.setText(`\`\`\`${block.language}\n${block.code}\n\`\`\``);
        this.container.addChild(m.node);
      } else if (block.text.trim()) {
        const m = this.nodes.markdown({ paddingX: 1 });
        m.setText(stripTrailing(block.text));
        this.container.addChild(m.node);
      }
    }
  }

  hasContent(): boolean {
    return this.buffer.trim().length > 0;
  }
}
