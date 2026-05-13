import type { ExtensionContext } from "agent-sh/types";
import type { MultiSessionStore, SessionInfo } from "./multi-session-store.js";
import type { Capture } from "./capture.js";
import { applyBranchMessages } from "./commands.js";

export interface SessionCommandsDeps {
  openSessionPicker: () => Promise<void>;
  rebuildChat: () => Promise<void>;
}

export function registerSessionCommands(
  ctx: ExtensionContext,
  getStore: () => MultiSessionStore,
  capture: Capture,
  deps: SessionCommandsDeps,
): void {
  const { bus } = ctx;

  ctx.registerCommand("resume", "Browse and resume a past session in this cwd", async () => {
    await deps.openSessionPicker();
  });

  ctx.registerCommand("new", "Start a fresh session (discards in-memory context)", async () => {
    const s = getStore().newSession();
    ctx.call("conversation:reset-for-session", 1);
    ctx.call("conversation:replace-messages", []);
    capture.resetTo([]);
    await deps.rebuildChat();
    bus.emit("ui:info", { message: `new session: ${s.id}` });
  });

  ctx.registerCommand("name", "Set the current session display name: /name <text>", async (args) => {
    const name = args.trim();
    if (!name) {
      bus.emit("ui:error", { message: "name: expected a name" });
      return;
    }
    getStore().current().setName(name);
    bus.emit("ui:info", { message: `session named: ${name}` });
  });

  ctx.registerCommand("sessions", "List past sessions in this cwd (text dump)", async () => {
    const list = getStore().listSessions();
    if (list.length === 0) {
      bus.emit("ui:info", { message: "sessions: none" });
      return;
    }
    const currentId = getStore().current().id;
    const lines = list.map((s) => formatSessionRow(s, s.id === currentId));
    bus.emit("ui:info", { message: `sessions (${list.length}):\n${lines.join("\n")}` });
  });
}

export function formatSessionRow(s: SessionInfo, isCurrent: boolean): string {
  const marker = isCurrent ? "●" : " ";
  const when = s.createdAt ? new Date(s.createdAt).toISOString().slice(0, 16).replace("T", " ") : "?";
  const label = s.name ?? s.preview;
  return `${marker} ${when}  ${label}  (${s.entryCount})`;
}

export function resumeSession(
  ctx: ExtensionContext,
  getStore: () => MultiSessionStore,
  capture: Capture,
  id: string,
): void {
  getStore().openSession(id);
  ctx.call("conversation:reset-for-session", 1);
  applyBranchMessages(ctx, getStore, capture);
}
