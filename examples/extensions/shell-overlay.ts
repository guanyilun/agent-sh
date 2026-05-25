/**
 * Shell overlay extension.
 *
 * Press Ctrl+] to summon a floating terminal over the agent UI. The
 * overlay renders the user's interactive shell pty (the same one that
 * normally writes to the bottom of the screen) via the headless xterm
 * already wired into the kernel. Keystrokes inside the overlay forward
 * raw to the pty — vim, htop, less and other alt-screen TUIs work
 * because xterm-headless interprets their sequences and the panel just
 * paints the resulting cell grid.
 *
 * Trigger key (Ctrl+]) closes the overlay; every other key (including
 * Esc, Ctrl+C, arrows, page keys) is forwarded to the pty. The trigger
 * differs from overlay-agent's Ctrl+\ so both overlays can coexist.
 *
 * Scrollback: while the shell is on the normal screen, PgUp/PgDn and
 * mouse-wheel navigate the shell's history. Any other key snaps back
 * to live and forwards. In alt-screen TUIs (vim/htop/less) the same
 * keys forward unchanged so the program scrolls itself.
 *
 * Requires @xterm/headless (installed by the terminal-buffer extension's
 * dependencies, or directly).
 */
import type { ExtensionContext } from "agent-sh/types";
import { FloatingPanel } from "agent-sh/utils/floating-panel";
import type { TerminalBuffer } from "agent-sh/utils/terminal-buffer";

const PREFIX = "shell-overlay";
const WHEEL_LINES = 3;

export default function activate(ctx: ExtensionContext): void {
  const { bus } = ctx;
  const tb = ctx.call("terminal-buffer") as TerminalBuffer | null;
  if (!tb) return;

  const panel = new FloatingPanel(bus, {
    trigger: "\x1d", // Ctrl+]
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

  // Scrollback anchor: absolute Y of the viewport top while scrolled.
  // null means live (follow the bottom of the buffer).
  let anchorY: number | null = null;
  let prevAltScreen = false;

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

  const updateTitle = (): void => {
    if (anchorY === null) panel.setTitle("shell");
    else {
      const back = Math.max(0, tb.getViewportBaseY() - anchorY);
      panel.setTitle(`shell · scrollback ${back}`);
    }
  };

  const setAnchor = (y: number | null): void => {
    anchorY = y;
    updateTitle();
    panel.requestRender();
  };

  const pageLines = (): number => Math.max(1, (lastRows || 24) - 1);

  const scrollUp = (lines: number): true => {
    const base = tb.getViewportBaseY();
    const cur = anchorY ?? base;
    const next = Math.max(0, cur - lines);
    setAnchor(next < base ? next : null);
    return true;
  };

  const scrollDown = (lines: number): boolean => {
    if (anchorY === null) return false;
    const next = anchorY + lines;
    setAnchor(next >= tb.getViewportBaseY() ? null : next);
    return true;
  };

  const mount = (): void => {
    if (mounted) return;
    mounted = true;
    anchorY = null;
    prevAltScreen = tb.altScreen;
    updateTitle();
    panel.setActive();
    unsubPtyData = bus.on("shell:pty-data", () => panel.requestRender());
  };

  const unmount = (): void => {
    if (!mounted) return;
    mounted = false;
    unsubPtyData?.(); unsubPtyData = null;
    restoreHostSize();
  };

  // ── Render: paint cell grid at the current anchor (or live) ──
  panel.handlers.define(`${PREFIX}:render-content`, (rc) => {
    syncSize(rc.width, rc.height);
    tb.flush();

    // Buffer switched (normal ↔ alternate). Coordinate spaces don't
    // overlap, so any active scrollback anchor becomes meaningless.
    if (tb.altScreen !== prevAltScreen) {
      prevAltScreen = tb.altScreen;
      if (anchorY !== null) setAnchor(null);
    }

    const lines = tb.getStyledLines(rc.height, anchorY ?? undefined);
    if (anchorY !== null) return { lines };

    const cur = tb.getCursor();
    return {
      lines,
      cursor: {
        row: Math.max(0, Math.min(rc.height - 1, cur.y)),
        col: Math.max(0, Math.min(rc.width - 1, cur.x)),
      },
    };
  });

  // ── Input: scrollback nav (normal screen only) or forward ───
  panel.handlers.define(`${PREFIX}:input`, (data: string): boolean => {
    if (!tb.altScreen) {
      if (data === "\x1b[5~") return scrollUp(pageLines());
      if (data === "\x1b[6~" && scrollDown(pageLines())) return true;
      if (data.length >= 6 && data.startsWith("\x1b[M")) {
        const btn = data.charCodeAt(3);
        if (btn === 96) return scrollUp(WHEEL_LINES);
        if (btn === 97 && scrollDown(WHEEL_LINES)) return true;
      }
      if (/^\x1b\[<64;\d+;\d+M$/.test(data)) return scrollUp(WHEEL_LINES);
      if (/^\x1b\[<65;\d+;\d+M$/.test(data) && scrollDown(WHEEL_LINES)) return true;
    }
    if (anchorY !== null) setAnchor(null);
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
