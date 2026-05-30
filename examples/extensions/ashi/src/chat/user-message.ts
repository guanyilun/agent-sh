import type { RenderNode, RenderNodes } from "../renderer.js";
import { theme } from "../theme.js";

export class UserMessage {
  readonly node: RenderNode;
  constructor(nodes: RenderNodes, text: string) {
    const container = nodes.container();
    container.addChild(nodes.spacer(1));
    const md = nodes.markdown({
      paddingX: 1,
      paddingY: 1,
      bgColor: (t) => theme.bg("userMessageBg", t),
      color: (t) => theme.fg("userMessageText", t),
      osc133Zones: true,
    });
    md.setText(text);
    container.addChild(md.node);
    this.node = container.node;
  }
}
