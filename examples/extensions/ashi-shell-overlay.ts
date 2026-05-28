/**
 * ashi-shell-overlay — full-screen shell overlay rendered as a pi-tui
 * Overlay inside ashi.
 *
 * Press the trigger key (default Ctrl+], "") to summon a pi-tui
 * overlay that paints the user's interactive shell pty via the kernel's
 * wired xterm-headless buffer. Keystrokes inside the overlay forward
 * raw to the pty — vim, htop, less and other alt-screen TUIs work
 * because xterm-headless interprets their sequences and we just paint
 * the resulting cell grid.
 *
 * Scrollback: while the shell is on the normal screen, PgUp/PgDn and
 * mouse-wheel navigate the shell's history. Any other key snaps back
 * to the live tail and forwards. In alt-screen TUIs all keys including
 * scroll forward unchanged so the program scrolls itself.
 *
 * Why ashi-specific: ashi captures stdin via pi-tui directly and gives
 * the kernel a no-op Terminal, so kernel-level overlays (FloatingPanel
 * + input:intercept) never see input under ashi. This version uses
 * ashi's pi-tui surface — input via tui.addInputListener and the
 * component's handleInput, rendering via tui.showOverlay.
 *
 * Configure trigger via ~/.agent-sh/settings.json:
 *   { "ashi-shell-overlay": { "trigger": "" } }
 */
import type { ExtensionContext } from "agent-sh/types";
import type { EventBus } from "agent-sh/event-bus";

declare module "agent-sh/event-bus" {
  interface BusEvents {
    /** Emitted by ashi after mountAshi has constructed the TUI. */
    "ashi:ready": Record<string, never>;
  }
}
import type { TerminalBuffer } from "agent-sh/utils/terminal-buffer";
// Type-only — pi-tui isn't a direct dep of agent-sh root; the TUI
// instance is handed over by ashi at runtime via ctx.call("ashi:tui").
import type { TUI, Component, OverlayHandle } from "@earendil-works/pi-tui";
import { matchesKey, isKeyRelease, isKeyRepeat } from "@earendil-works/pi-tui";

// Pi-tui's APC cursor marker (tui.d.ts:54). Stable across versions.
const CURSOR_MARKER = "_pi:c";

const WHEEL_LINES = 3;

export default function activate(ctx: ExtensionContext): void {
  const { bus } = ctx;
  const tb = ctx.call("terminal-buffer") as TerminalBuffer | null;
  if (!tb) return;

  const { trigger } = ctx.getExtensionSettings("ashi-shell-overlay", { trigger: "ctrl+]" });

  let attached = false;
  const attach = (): void => {
    if (attached) return;
    attached = true;
    const tui = ctx.call("ashi:tui") as TUI | undefined;
    if (!tui) return;
    attachOverlay(ctx, bus, tb, tui, trigger);
  };

  // If ashi is already up by the time we activate (extension reload, etc.),
  // ctx.call resolves immediately; otherwise the bus event arrives later.
  if ((ctx.call("ashi:tui") as TUI | undefined) !== undefined) {
    attach();
  } else {
    bus.on("ashi:ready", attach);
  }
}

function attachOverlay(
  ctx: ExtensionContext,
  bus: EventBus,
  tb: TerminalBuffer,
  tui: TUI,
  trigger: string,
): void {
  let handle: OverlayHandle | null = null;
  let component: ShellOverlayComponent | null = null;
  let restore: { cols: number; rows: number; hardwareCursor: boolean } | null = null;
  const onPtyData = (): void => tui.requestRender();

  const show = (): void => {
    if (handle) return;
    restore = {
      cols: tui.terminal.columns,
      rows: tui.terminal.rows,
      hardwareCursor: tui.getShowHardwareCursor(),
    };
    component = new ShellOverlayComponent(tb, bus, tui, hide, trigger);
    handle = tui.showOverlay(component, {
      width: "100%",
      maxHeight: "100%",
      anchor: "top-left",
    });
    tui.setShowHardwareCursor(true);
    bus.on("shell:pty-data", onPtyData);
    tui.requestRender();
  };

  const hide = (): void => {
    if (!handle) return;
    handle.hide();
    handle = null;
    component = null;
    bus.off("shell:pty-data", onPtyData);
    if (restore) {
      tui.setShowHardwareCursor(restore.hardwareCursor);
      bus.emit("shell:pty-resize", { cols: restore.cols, rows: restore.rows });
      tb.resize(restore.cols, restore.rows);
      restore = null;
    }
  };

  // The trigger reaches this listener when no overlay is open (ashi's
  // listener early-returns under hasOverlay, ours runs after). When the
  // overlay is open the component's handleInput handles the trigger.
  const onInput = (data: string): { consume?: boolean } | undefined => {
    if (isKeyRelease(data) || isKeyRepeat(data)) return;
    if (handle) return;
    if (matchesKey(data, trigger)) { show(); return { consume: true }; }
    return undefined;
  };
  const unsubInput = tui.addInputListener(onInput);

  ctx.onDispose(() => {
    unsubInput();
    hide();
  });
}

class ShellOverlayComponent implements Component {
  focused = false;
  private anchorY: number | null = null;
  private prevAltScreen = false;
  private lastCols = 0;
  private lastRows = 0;

  constructor(
    private readonly tb: TerminalBuffer,
    private readonly bus: EventBus,
    private readonly tui: TUI,
    private readonly onClose: () => void,
    private readonly trigger: string,
  ) {
    this.prevAltScreen = tb.altScreen;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const height = this.tui.terminal.rows;
    this.syncSize(width, height);
    this.tb.flush();

    // Buffer transitions (normal ↔ alt) invalidate the anchor — different
    // coordinate spaces.
    if (this.tb.altScreen !== this.prevAltScreen) {
      this.prevAltScreen = this.tb.altScreen;
      this.anchorY = null;
    }

    const lines = this.tb.getStyledLines(height, this.anchorY ?? undefined);

    if (this.anchorY === null) {
      const cur = this.tb.getCursor();
      const cy = Math.max(0, Math.min(lines.length - 1, cur.y));
      const cx = Math.max(0, Math.min(width - 1, cur.x));
      lines[cy] = insertCursorAt(lines[cy] ?? "", cx);
    }

    return lines;
  }

  handleInput(data: string): void {
    if (matchesKey(data, this.trigger)) { this.onClose(); return; }

    if (!this.tb.altScreen) {
      const page = Math.max(1, (this.lastRows || 24) - 1);
      if (data === "\x1b[5~") { this.scrollUp(page); return; }
      if (data === "\x1b[6~" && this.scrollDown(page)) return;
      if (data.length >= 6 && data.startsWith("\x1b[M")) {
        const btn = data.charCodeAt(3);
        if (btn === 96) { this.scrollUp(WHEEL_LINES); return; }
        if (btn === 97 && this.scrollDown(WHEEL_LINES)) return;
      }
      if (/^\x1b\[<64;\d+;\d+M$/.test(data)) { this.scrollUp(WHEEL_LINES); return; }
      if (/^\x1b\[<65;\d+;\d+M$/.test(data) && this.scrollDown(WHEEL_LINES)) return;
    }

    if (this.anchorY !== null) {
      this.anchorY = null;
      this.tui.requestRender();
    }
    this.bus.emit("shell:pty-write", { data: toPtyBytes(data) });
  }

  private syncSize(cols: number, rows: number): void {
    if (cols === this.lastCols && rows === this.lastRows) return;
    this.lastCols = cols;
    this.lastRows = rows;
    this.bus.emit("shell:pty-resize", { cols, rows });
    this.tb.resize(cols, rows);
  }

  private scrollUp(lines: number): void {
    const base = this.tb.getViewportBaseY();
    const cur = this.anchorY ?? base;
    const next = Math.max(0, cur - lines);
    this.anchorY = next < base ? next : null;
    this.tui.requestRender();
  }

  private scrollDown(lines: number): boolean {
    if (this.anchorY === null) return false;
    const next = this.anchorY + lines;
    this.anchorY = next >= this.tb.getViewportBaseY() ? null : next;
    this.tui.requestRender();
    return true;
  }
}

/**
 * Convert a pi-tui-encoded keystroke back to the legacy byte sequence a PTY
 * expects. Pi-tui negotiates Kitty CSI-u (`\x1b[<cp>;<mod>u`) or xterm
 * modifyOtherKeys (`\x1b[27;<mod>;<cp>~`) at startup, so Ctrl+B arrives as
 * `\x1b[98;5u`, not `\x02`. The shell doesn't understand those forms and
 * would echo the raw bytes. We undo the encoding for the common Ctrl+printable
 * case; other sequences pass through (legacy CSI like arrows already works,
 * plain printables come through as-is).
 */
function toPtyBytes(data: string): string {
  // Kitty CSI-u: \x1b[<cp>[:<shifted>[:<base>]][;<mod>[:<event>][;<text>]]u
  let m = /^\x1b\[(\d+)(?::(\d+))?(?::\d+)?(?:;(\d+)(?::\d+)?(?:;\d+)?)?u$/.exec(data);
  if (m) {
    return encodeKey(Number(m[1]), m[2] ? Number(m[2]) : undefined, m[3] ? Number(m[3]) - 1 : 0) ?? data;
  }
  // xterm modifyOtherKeys: \x1b[27;<mod>;<keycode>~
  m = /^\x1b\[27;(\d+);(\d+)~$/.exec(data);
  if (m) return encodeKey(Number(m[2]), undefined, Number(m[1]) - 1) ?? data;
  return data;
}

function encodeKey(codepoint: number, shifted: number | undefined, modifier: number): string | null {
  const SHIFT = 1, ALT = 2, CTRL = 4;
  // Ctrl+printable → legacy ctrl byte
  if ((modifier & CTRL) && !(modifier & ALT)) {
    if (codepoint === 0x20) return "\x00";
    if (codepoint >= 0x40 && codepoint <= 0x7e) return String.fromCharCode(codepoint & 0x1f);
    if (codepoint >= 0x61 && codepoint <= 0x7a) return String.fromCharCode(codepoint - 0x60);
  }
  // Plain or shift-only → emit the codepoint as a char. Covers Enter (13), Tab (9),
  // Escape (27), Backspace (127), printables, and shift+letter (uses shifted_codepoint
  // when kitty supplies it, else uppercases ASCII letters).
  if (!(modifier & ~SHIFT)) {
    let cp = codepoint;
    if ((modifier & SHIFT) && typeof shifted === "number") cp = shifted;
    else if ((modifier & SHIFT) && cp >= 0x61 && cp <= 0x7a) cp -= 0x20;
    if (Number.isFinite(cp) && cp < 0xE000) {
      try { return String.fromCodePoint(cp); } catch { return null; }
    }
  }
  return null;
}

/**
 * Insert pi-tui's CURSOR_MARKER at visible column `col` in a styled line.
 * Walks the line skipping SGR CSI sequences (everything our styleLine emits
 * is `\x1b[...m`), pads with spaces if the line is shorter than `col`.
 */
function insertCursorAt(line: string, col: number): string {
  let visible = 0;
  let i = 0;
  while (i < line.length && visible < col) {
    if (line[i] === "\x1b" && line[i + 1] === "[") {
      i += 2;
      while (i < line.length && line[i] !== "m") i++;
      i++;
      continue;
    }
    visible++;
    i++;
  }
  const pad = " ".repeat(Math.max(0, col - visible));
  return line.slice(0, i) + pad + CURSOR_MARKER + line.slice(i);
}
