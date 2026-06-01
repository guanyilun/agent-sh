/**
 * ashi UI-surface demo — exercises every surface via the typed `@guanyilun/ashi/ui` helper.
 *
 * Usage:  ashi -e ashi-ui-demo        (or -e examples/extensions/ashi-ui-demo.ts)
 *
 * Adds a pinned dock line and a status segment, plus commands:
 *   /ui-demo        walk the dialogs (select → confirm → input) + notify
 *   /ui-demo-bump   bump the status segment and re-pull the footer
 *   /ui-demo-dock   toggle the dock widget and re-pull the dock
 */
import { createUi } from "@guanyilun/ashi/ui";
import type { ExtensionContext } from "agent-sh/types";

export default function activate(ctx: ExtensionContext): void {
  const ui = createUi(ctx);
  let bumps = 0;
  let dockOn = true;

  const status = ui.status(() => ({ id: "demo", text: `✦ demo ${bumps}`, color: "accent" }));
  const dock = ui.dock((nodes) => {
    if (!dockOn) return null;
    const line = nodes.text({ paddingX: 1 });
    line.setText("📌 ui-demo: a pinned dock widget");
    return line.node;
  });

  ctx.registerCommand("ui-demo-bump", "Bump the demo status segment", () => {
    bumps++;
    status.refresh();
  });

  ctx.registerCommand("ui-demo-dock", "Toggle the demo dock widget", () => {
    dockOn = !dockOn;
    dock.refresh();
  });

  ctx.registerCommand("ui-demo", "Walk the ashi UI dialogs (select/confirm/input)", async () => {
    ui.notify("ui-demo: starting…");

    const fruit = await ui.select({
      title: "Pick a fruit",
      items: [
        { value: "apple", label: "Apple", description: "crisp" },
        { value: "banana", label: "Banana", description: "soft" },
        { value: "cherry", label: "Cherry" },
      ],
    });
    if (!fruit) {
      ui.notify("ui-demo: cancelled", "warn");
      return;
    }

    if (!(await ui.confirm({ title: `Really pick ${fruit}?` }))) {
      ui.notify("ui-demo: not confirmed", "warn");
      return;
    }

    const note = await ui.input({ title: "Add a note — enter to submit, esc to skip" });
    const summary = `picked ${fruit}${note ? ` — ${note}` : ""}`;
    ui.setEditorText(`/* ${summary} */`);
    ui.notify(`ui-demo: ${summary}`, "success");
  });
}
