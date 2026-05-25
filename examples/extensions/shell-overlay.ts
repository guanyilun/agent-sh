/**
 * Shell overlay extension.
 *
 * Press Ctrl+\ to summon a floating terminal over the agent UI. The
 * overlay renders the user's interactive shell pty (the same one that
 * normally writes to the bottom of the screen) via the headless xterm
 * already wired into the kernel. Keystrokes inside the overlay forward
 * raw to the pty — vim, htop, less and other alt-screen TUIs work
 * because xterm-headless interprets their sequences and the panel just
 * paints the resulting cell grid.
 *
 * Trigger key (Ctrl+\) closes the overlay; every other key (including
 * Esc, Ctrl+C, arrows, page keys) is forwarded to the pty.
 *
 * Requires @xterm/headless (installed by the terminal-buffer extension's
 * dependencies, or directly).
 */
import type { ExtensionContext } from "agent-sh/types";
import { FloatingPanel } from "agent-sh/utils/floating-panel";
import type { TerminalBuffer } from "agent-sh/utils/terminal-buffer";

const PREFIX = "shell-overlay";

export default function activate(ctx: ExtensionContext): void {
  const { bus } = ctx;
  const tb = ctx.call("terminal-buffer") as TerminalBuffer | null;
  if (!tb) return;

  const panel = new FloatingPanel(bus, {
    trigger: "\x1c", // Ctrl+\
    width: "100%",
    height: "100%",
    dimBackground: false, // we render the shell ourselves
    borderStyle: "rounded",
    handlerPrefix: PREFIX,
  });

  let mounted = false;
  let unsubPtyData: (() => void) | null = null;
  let lastCols = 0;
  let lastRows = 0;

  const syncSize = (cols: number, rows: number): void => {
    if (cols === lastCols && rows === lastRows) return;
    lastCols = cols;
    lastRows = rows;
    bus.emit("shell:pty-resize", { cols, rows });
    tb.resize(cols, rows);
  };

  const restoreHostSize = (): void => {
    const { cols, rows } = panel.computeGeometry();
    bus.emit("shell:pty-resize", { cols, rows });
    tb.resize(cols, rows);
    lastCols = 0;
    lastRows = 0;
  };

  const mount = (): void => {
    if (mounted) return;
    mounted = true;
    panel.setActive();
    unsubPtyData = bus.on("shell:pty-data", () => panel.requestRender());
  };

  const unmount = (): void => {
    if (!mounted) return;
    mounted = false;
    unsubPtyData?.(); unsubPtyData = null;
    restoreHostSize();
  };

  // ── Render: sync size from panel geometry, paint cell grid ───
  panel.handlers.define(`${PREFIX}:render-content`, (rc) => {
    syncSize(rc.width, rc.height);
    tb.flush();
    const lines = tb.getStyledLines(rc.height);
    const cur = tb.getCursor();
    return {
      lines,
      cursor: {
        row: Math.max(0, Math.min(rc.height - 1, cur.y)),
        col: Math.max(0, Math.min(rc.width - 1, cur.x)),
      },
    };
  });

  // ── Raw key forwarding ───────────────────────────────────────
  panel.handlers.define(`${PREFIX}:input`, (data: string): boolean => {
    bus.emit("shell:pty-write", { data });
    return true;
  });

  // ── Lifecycle ────────────────────────────────────────────────
  panel.handlers.advise(`${PREFIX}:open`, (next) => { mount(); next(); });

  // No background processing — hide means close. Force a full reset
  // after the panel's hide() so the next trigger reopens fresh.
  panel.handlers.advise(`${PREFIX}:hide`, (next) => {
    unmount();
    next();
    if (panel.active) panel.reset();
  });

  panel.handlers.advise(`${PREFIX}:reset`, (next) => { unmount(); next(); });

  ctx.onDispose(() => {
    unmount();
    if (panel.active) panel.reset();
  });
}
