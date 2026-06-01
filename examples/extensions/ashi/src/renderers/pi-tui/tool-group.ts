import { renderToolGroupLines, type ToolGroupModel, type ToolGroupView } from "../../renderer.js";
import { createNodes } from "./nodes.js";

export function createPiTuiToolGroup(): ToolGroupView {
  const nodes = createNodes();
  const container = nodes.container();
  container.addChild(nodes.spacer(1));
  const text = nodes.text({ paddingX: 1 });
  container.addChild(text.node);

  const update = (model: ToolGroupModel): void => {
    // paddingX:1 on both sides → content area is width-2; render width-aware so
    // long paths truncate to fit rather than wrap.
    text.setRenderFn((width) => renderToolGroupLines(model, Math.max(1, width - 2)));
  };

  return { node: container.node, update };
}
