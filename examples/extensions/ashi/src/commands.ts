import type { ExtensionContext } from "agent-sh/types";
import { type NuclearEntry, formatNuclearLine } from "agent-sh/core";
import type { TreeHistoryAdapter } from "./tree-history.js";

export function registerTreeCommands(
  ctx: ExtensionContext,
  tree: TreeHistoryAdapter,
): void {
  const { bus } = ctx;

  ctx.registerCommand("tree", "Show the history tree (active branch + sibling counts)", async () => {
    const all = await tree.getTree();
    if (all.length === 0) {
      bus.emit("ui:info", { message: "tree: empty" });
      return;
    }
    const activeLeaf = tree.getActiveLeaf();
    const branchSeqs = new Set((await tree.getBranch(activeLeaf)).map((e) => e.seq));
    const childCount = new Map<number, number>();
    for (const e of all) {
      if (e.parentSeq == null) continue;
      childCount.set(e.parentSeq, (childCount.get(e.parentSeq) ?? 0) + 1);
    }
    const lines = all.map((e) => formatRow(e, branchSeqs, childCount, activeLeaf));
    bus.emit("ui:info", { message: `tree (active leaf #${activeLeaf}):\n${lines.join("\n")}` });
  });

  ctx.registerCommand("fork", "Fork the next turn from a specific seq: /fork <seq>", async (args) => {
    const trimmed = args.trim();
    const seq = trimmed === "" ? 0 : parseInt(trimmed, 10);
    if (Number.isNaN(seq)) {
      bus.emit("ui:error", { message: "fork: expected a numeric seq" });
      return;
    }
    if (seq !== 0 && !(await tree.findBySeq(seq))) {
      bus.emit("ui:error", { message: `fork: no entry at seq ${seq}` });
      return;
    }
    tree.setLeaf(seq);
    bus.emit("ui:info", {
      message: `fork: next turn parents from #${seq}. (Caveat: the agent's in-context messages don't rewind — only the on-disk parent pointer changes.)`,
    });
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

function formatRow(
  e: NuclearEntry,
  branchSeqs: Set<number>,
  childCount: Map<number, number>,
  activeLeaf: number,
): string {
  const onBranch = branchSeqs.has(e.seq);
  const marker = e.seq === activeLeaf ? "●" : onBranch ? "│" : " ";
  const kids = childCount.get(e.seq) ?? 0;
  const fork = kids > 1 ? ` (${kids} branches)` : "";
  const parent = e.parentSeq != null ? ` ← #${e.parentSeq}` : "";
  return `${marker} #${e.seq} ${e.sum}${parent}${fork}`;
}
