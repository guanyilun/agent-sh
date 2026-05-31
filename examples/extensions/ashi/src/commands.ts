import type { ExtensionContext } from "agent-sh/types";
import type { MultiSessionStore } from "./multi-session-store.js";
import type { Capture } from "./capture.js";

export function registerForkCommands(
  ctx: ExtensionContext,
  getStore: () => MultiSessionStore,
  openTreePicker: () => Promise<void>,
  rebuildChat: () => Promise<void>,
  capture: Capture,
): void {
  const { bus } = ctx;

  ctx.registerCommand("fork", "Pick a past user message to edit, or a branch tip to switch to", async (args) => {
    const arg = args.trim();
    if (arg === "") {
      await openTreePicker();
      return;
    }
    const matches = getStore().current().getAllEntries().filter((e) => e.id.startsWith(arg));
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
    applyBranchMessages(ctx, getStore, capture);
    bus.emit("ui:info", { message: `fork: rewound to ${target.id}` });
    await rebuildChat();
  });
}

export function applyBranchMessages(
  ctx: ExtensionContext,
  getStore: () => MultiSessionStore,
  capture: Capture,
): void {
  const store = getStore().current();
  const messages = store.buildMessages();
  ctx.call("conversation:replace-messages", messages);

  // replace-messages no-ops until the agent backend is active; seeding then desyncs
  // capture's baseline against an empty conversation and silently drops later turns.
  const live = ctx.call("conversation:get-messages") as unknown[] | undefined;
  if ((live?.length ?? 0) !== messages.length) {
    throw new Error(
      `applyBranchMessages: conversation not seeded (live ${live?.length ?? 0} vs ${messages.length}); call after the agent backend is active`,
    );
  }

  const branch = store.getBranch();
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
