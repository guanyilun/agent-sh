import type { ExtensionContext } from "agent-sh/types";
import { type NuclearEntry, formatNuclearLine } from "agent-sh/core";
import type { TreeHistoryAdapter } from "./tree-history.js";

export function registerSessionRestore(ctx: ExtensionContext, tree: TreeHistoryAdapter): void {
  ctx.advise("conversation:format-prior-history", (_next: unknown, entries: NuclearEntry[]) => {
    if (tree.hasSnapshot(tree.getActiveLeaf())) return null;
    if (!entries || entries.length === 0) return null;
    const parts: string[] = ["[Prior session history]"];
    for (const e of entries) {
      if (e.kind === "compaction" && e.body) {
        parts.push(`\n--- Compaction at #${e.seq} ---\n${e.body}\n--- End compaction ---\n`);
      } else {
        parts.push(formatNuclearLine(e));
      }
    }
    return parts.join("\n");
  });

  ctx.bus.on("agent:processing-done", () => {
    const messages = ctx.call("conversation:get-messages") as unknown[] | undefined;
    if (!messages) return;
    tree.saveSnapshot(tree.getActiveLeaf(), messages);
  });
}

export function restoreSnapshot(ctx: ExtensionContext, tree: TreeHistoryAdapter): boolean {
  const leaf = tree.getActiveLeaf();
  const snapshot = tree.loadSnapshot(leaf);
  if (!snapshot || snapshot.length === 0) return false;
  ctx.call("conversation:replace-messages", snapshot);
  ctx.bus.emit("ui:info", { message: `restored ${snapshot.length} messages from snapshot @ #${leaf}` });
  return true;
}
