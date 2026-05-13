import type { ExtensionContext } from "agent-sh/types";
import { formatNuclearLine } from "agent-sh/core";
import type { SessionTree } from "./leaf-tracking-tree-history.js";

export function registerTreeCommands(
  ctx: ExtensionContext,
  tree: SessionTree,
  openTreePicker: () => Promise<void>,
  rebuildChat: () => Promise<void>,
): void {
  const { bus } = ctx;

  ctx.registerCommand("fork", "Rewind and branch: /fork (interactive picker) or /fork <seq>", async (args) => {
    const trimmed = args.trim();
    if (trimmed === "") {
      await openTreePicker();
      return;
    }
    const seq = parseInt(trimmed, 10);
    if (Number.isNaN(seq) || seq < 1) {
      bus.emit("ui:error", { message: "fork: expected a positive numeric seq" });
      return;
    }
    if (!(await tree.findBySeq(seq))) {
      bus.emit("ui:error", { message: `fork: no entry at seq ${seq}` });
      return;
    }
    tree.setLeaf(seq);
    const snapshot = tree.loadSnapshot(seq);
    if (snapshot && snapshot.length > 0) {
      ctx.call("conversation:replace-messages", snapshot);
      bus.emit("ui:info", { message: `fork: restored ${snapshot.length} messages from snapshot @ #${seq}` });
    } else {
      bus.emit("ui:info", { message: `fork: next turn parents from #${seq} (no snapshot — agent context not rewound)` });
    }
    await rebuildChat();
  });

  ctx.registerCommand("branch", "Show the active branch (root → leaf)", async () => {
    const branch = await tree.getBranch(tree.getActiveLeaf());
    if (branch.length === 0) {
      bus.emit("ui:info", { message: "branch: empty" });
      return;
    }
    const lines = branch.map(formatNuclearLine);
    bus.emit("ui:info", { message: `branch (${branch.length} entries):\n${lines.join("\n")}` });
  });
}
