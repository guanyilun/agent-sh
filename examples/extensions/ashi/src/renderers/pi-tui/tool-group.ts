import { renderToolGroupLines, type ToolGroupModel, type ToolGroupView } from "../../renderer.js";
import { createNodes } from "./nodes.js";

export function createPiTuiToolGroup(): ToolGroupView {
  const nodes = createNodes();
  const rows = nodes.container();
  const container = nodes.container();
  container.addChild(nodes.spacer(1));
  container.addChild(rows.node);

  const update = (model: ToolGroupModel): void => {
    // Rebuild rather than diff the rows: group sizes are small.
    rows.clear();
    for (const line of renderToolGroupLines(model)) {
      const t = nodes.text({ paddingX: 1 });
      t.setText(line);
      rows.addChild(t.node);
    }
  };

  return { node: container.node, update };
}
