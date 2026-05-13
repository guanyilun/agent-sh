import type { ExtensionContext } from "agent-sh/types";
import type { MultiSessionTreeAdapter, SessionInfo } from "./multi-session-tree-history.js";

export interface SessionCommandsDeps {
  openSessionPicker: () => Promise<void>;
  applySessionSnapshot: () => void;
}

export function registerSessionCommands(
  ctx: ExtensionContext,
  sessions: MultiSessionTreeAdapter,
  deps: SessionCommandsDeps,
): void {
  const { bus } = ctx;

  ctx.registerCommand("resume", "Browse and resume a past session in this cwd", async () => {
    await deps.openSessionPicker();
  });

  ctx.registerCommand("new", "Start a fresh session (discards in-memory state)", async () => {
    const id = sessions.newSession();
    ctx.call("conversation:reset-for-session", 1);
    ctx.call("conversation:replace-messages", []);
    bus.emit("ui:info", { message: `new session: ${id}` });
  });

  ctx.registerCommand("name", "Set the current session display name: /name <text>", async (args) => {
    const name = args.trim();
    if (!name) {
      bus.emit("ui:error", { message: "name: expected a name" });
      return;
    }
    sessions.setName(name);
    bus.emit("ui:info", { message: `session named: ${name}` });
  });

  ctx.registerCommand("sessions", "List past sessions in this cwd (text dump)", async () => {
    const list = await sessions.listSessions();
    if (list.length === 0) {
      bus.emit("ui:info", { message: "sessions: none" });
      return;
    }
    const lines = list.map((s) => formatSessionRow(s, s.id === sessions.getCurrentId()));
    bus.emit("ui:info", { message: `sessions (${list.length}):\n${lines.join("\n")}` });
  });
}

export function formatSessionRow(s: SessionInfo, isCurrent: boolean): string {
  const marker = isCurrent ? "●" : " ";
  const when = s.createdAt ? new Date(s.createdAt).toISOString().slice(0, 16).replace("T", " ") : "?";
  const label = s.name ?? s.preview ?? "(empty)";
  return `${marker} ${when}  ${label}  (${s.entryCount})`;
}
