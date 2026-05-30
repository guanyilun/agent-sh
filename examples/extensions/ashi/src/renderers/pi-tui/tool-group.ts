import { theme } from "../../theme.js";
import type { ToolGroupChild, ToolGroupModel, ToolGroupView } from "../../renderer.js";
import { createNodes } from "./nodes.js";

export function createPiTuiToolGroup(): ToolGroupView {
  const nodes = createNodes();
  const headerText = nodes.text({ paddingX: 1 });
  const summaryText = nodes.text({ paddingX: 1 });
  const childContainer = nodes.container();
  const container = nodes.container();
  container.addChild(nodes.spacer(1));
  container.addChild(headerText.node);
  container.addChild(summaryText.node);
  container.addChild(childContainer.node);

  const update = (model: ToolGroupModel): void => {
    headerText.setText(`${theme.fg("warning", model.icon)} ${theme.bold(theme.fg("toolTitle", model.kind))}`);
    if (!model.hidden) {
      summaryText.setText("");
    } else {
      const mark = model.hidden.ok ? theme.fg("success", "✓") : theme.fg("error", "✗");
      const noun = model.hidden.count === 1 ? "earlier call" : "earlier calls";
      summaryText.setText(
        `${theme.fg("muted", "├")} ${theme.fg("muted", "⋯")} ${theme.fg("muted", `${model.hidden.count} ${noun}`)} ${mark}`,
      );
    }
    // Rebuild rather than diff the child container: group sizes are small.
    childContainer.clear();
    model.children.forEach((child, idx) => {
      const t = nodes.text({ paddingX: 1 });
      t.setText(renderRow(child, idx === model.children.length - 1, model.kind));
      childContainer.addChild(t.node);
    });
  };

  return { node: container.node, update };
}

function renderRow(child: ToolGroupChild, isLast: boolean, kind: string): string {
  let tail: string;
  if (!child.status) {
    tail = ` ${theme.fg("muted", "…")}`;
  } else {
    const ok = child.status.exitCode === null || child.status.exitCode === 0;
    const mark = ok ? theme.fg("success", "✓") : theme.fg("error", "✗");
    const sum = child.status.summary ? ` ${theme.fg("muted", child.status.summary)}` : "";
    tail = ` ${mark}${sum}`;
  }
  const connector = isLast ? "└" : "├";
  const namePart = child.name !== kind ? `${theme.bold(theme.fg("toolTitle", child.name))} ` : "";
  return `${theme.fg("muted", connector)} ${namePart}${theme.fg("muted", child.detail)} ${tail}`;
}
