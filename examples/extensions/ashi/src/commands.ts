import type { ExtensionContext } from "agent-sh/types";
import type { MultiSessionStore } from "./multi-session-store.js";
import type { AgentMessage } from "./session-store.js";
import type { Capture } from "./capture.js";

export function registerForkCommands(
  ctx: ExtensionContext,
  getStore: () => MultiSessionStore,
  openTreePicker: () => Promise<void>,
  rebuildChat: () => Promise<void>,
  capture: Capture,
): void {
  const { bus } = ctx;

  ctx.registerCommand("fork", "Rewind and branch: /fork (interactive picker) or /fork <id-prefix>", async (args) => {
    const arg = args.trim();
    if (arg === "") {
      await openTreePicker();
      return;
    }
    const branch = await getStore().current().getBranch();
    const matches = branch.filter((e) => e.id.startsWith(arg));
    if (matches.length === 0) {
      bus.emit("ui:error", { message: `fork: no entry matches "${arg}"` });
      return;
    }
    if (matches.length > 1) {
      bus.emit("ui:error", { message: `fork: ambiguous prefix "${arg}" matches ${matches.length} entries` });
      return;
    }
    const target = matches[0]!;
    getStore().current().setActiveLeaf(target.id);
    await applyBranchMessages(ctx, getStore, capture);
    bus.emit("ui:info", { message: `fork: rewound to ${target.id}` });
    await rebuildChat();
  });

  ctx.registerCommand("branch", "Show the active branch (root → leaf)", async () => {
    const branch = await getStore().current().getBranch();
    if (branch.length === 0) {
      bus.emit("ui:info", { message: "branch: empty" });
      return;
    }
    const lines = branch.map((e) => {
      if (e.type === "session") return `[${e.id}] session start (${e.cwd})`;
      if (e.type === "compaction") return `[${e.id}] compaction (firstKept=${e.firstKeptId})`;
      const msg = (e as { message: AgentMessage }).message;
      const text = typeof msg.content === "string" ? msg.content : "";
      return `[${e.id}] ${msg.role}: ${text.slice(0, 60)}`;
    });
    bus.emit("ui:info", { message: `branch (${branch.length} entries):\n${lines.join("\n")}` });
  });
}

export async function applyBranchMessages(
  ctx: ExtensionContext,
  getStore: () => MultiSessionStore,
  capture: Capture,
): Promise<void> {
  const store = getStore().current();
  ctx.call("conversation:replace-messages", await store.buildMessages());

  const branch = await store.getBranch();
  let compaction: { firstKeptId: string } | null = null;
  for (let i = branch.length - 1; i >= 0; i--) {
    if (branch[i]!.type === "compaction") {
      compaction = branch[i] as { firstKeptId: string };
      break;
    }
  }
  const ids: (string | null)[] = [];
  if (compaction) {
    ids.push(null);
    const startIdx = branch.findIndex((e) => e.id === compaction!.firstKeptId);
    for (let i = Math.max(0, startIdx); i < branch.length; i++) {
      if (branch[i]!.type === "message") ids.push(branch[i]!.id);
    }
  } else {
    for (const e of branch) if (e.type === "message") ids.push(e.id);
  }
  capture.resetTo(ids);
}
