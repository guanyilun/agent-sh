/**
 * Overlay agent extension.
 *
 * Press Ctrl+\ from anywhere — a shell prompt, vim, ssh, htop, a REPL — to
 * summon the agent in a floating panel composited over the current terminal.
 * The agent sees the live screen as `<terminal_buffer>` context (when a TUI
 * is active) or `<shell_events>` (at a shell prompt), so screen-aware
 * questions answer without a tool round-trip.
 *
 * Install (from an npm install of agent-sh):
 *   mkdir -p ~/.agent-sh/extensions
 *   cp "$(npm root -g)/agent-sh/examples/extensions/overlay-agent.ts" \
 *      ~/.agent-sh/extensions/
 *
 * Or load ad-hoc without copying:
 *   agent-sh -e "$(npm root -g)/agent-sh/examples/extensions/overlay-agent.ts"
 *
 * Optional companion extensions (copy the same way) — without them the
 * overlay can read the screen but cannot interact with it:
 *   - terminal-buffer.ts → terminal_read / terminal_keys tools
 *   - user-shell.ts      → user_shell tool (run new shell commands)
 */
import type { ShellContext, RemoteSession } from "agent-sh/types";
import type { RenderSurface } from "agent-sh/utils/compositor";
import { FloatingPanel } from "agent-sh/utils/floating-panel";
import { formatScreenContext, type TerminalBuffer } from "agent-sh/utils/terminal-buffer";

/** Adapt a FloatingPanel to the RenderSurface interface. */
function createPanelSurface(panel: FloatingPanel): RenderSurface {
  // Track the spinner row so a stop-clear ("\r\x1b[2K") removes it
  // instead of leaving an orphan blank line in the panel.
  let spinnerLine = false;
  return {
    write(text: string): void {
      if (text.startsWith("\r")) {
        const cleaned = text.replace(/^\r/, "").replace(/\x1b\[\d*K/g, "");
        if (cleaned.trim()) {
          if (spinnerLine) panel.updateLastLine(() => cleaned);
          else { panel.appendLine(cleaned); spinnerLine = true; }
        } else if (spinnerLine) {
          panel.popLastLine();
          spinnerLine = false;
        }
        return;
      }
      if (spinnerLine) { panel.popLastLine(); spinnerLine = false; }
      panel.appendText(text);
    },
    writeLine(line: string): void {
      panel.appendLine(line);
    },
    get columns(): number {
      return panel.computeGeometry().contentW;
    },
    get rows(): number {
      return panel.computeGeometry().contentH;
    },
    onResize(cb: (cols: number, rows: number) => void): () => void {
      const handler = () => {
        const g = panel.computeGeometry();
        cb(g.contentW, g.contentH);
      };
      process.stdout.on("resize", handler);
      return () => { process.stdout.off("resize", handler); };
    },
  };
}

export default function activate(ctx: ShellContext): void {
  const { bus, registerInstruction, createRemoteSession } = ctx;
  const terminalBuffer: TerminalBuffer | null = ctx.call("terminal-buffer");

  const panel = new FloatingPanel(bus, {
    trigger: "\x1c", // Ctrl+\
    dimBackground: true,
    terminalBuffer: terminalBuffer ?? undefined,
  });

  const panelSurface = createPanelSurface(panel);
  let session: RemoteSession | null = null;

  ctx.registerContextProducer("interactive-session", () =>
    session?.active ? "interactive-session: true" : null,
  );

  // Inject the live screen for TUI / REPL programs. At a plain shell prompt
  // `<shell_events>` already covers the visible scrollback — skip to dedupe.
  ctx.registerContextProducer("terminal-screen", () => {
    if (!session?.active || !terminalBuffer?.altScreen) return null;
    return formatScreenContext(terminalBuffer.readScreen(), 80);
  });

  registerInstruction("Interactive Overlay Sessions", [
    "When dynamic context includes `interactive-session: true`, the user summoned you via a",
    "hotkey overlay from their live terminal. They're mid-workflow (shell prompt, vim, ssh, a",
    "REPL, etc.) — keep responses concise and prefer reading what's on screen over asking.",
  ].join("\n"));

  // ── Panel lifecycle ────────────────────────────────────────────

  panel.handlers.advise("panel:submit", (_next, query: string) => {
    if (!session) {
      session = createRemoteSession({
        surface: panelSurface,
      });
    }
    if (query.startsWith("/")) {
      // Sync commands (/model, /help) render via ui:info and leave us in
      // input phase; ones that fan out to agent:submit flip the phase via
      // the agent:processing-start listener below.
      const spaceIdx = query.indexOf(" ");
      const name = spaceIdx === -1 ? query : query.slice(0, spaceIdx);
      const args = spaceIdx === -1 ? "" : query.slice(spaceIdx + 1).trim();
      bus.emit("command:execute", { name, args });
    } else {
      panel.setActive();
      session.submit(query);
    }
  });

  panel.handlers.advise("panel:show", (_next) => {
    if (panel.active && !session) {
      session = createRemoteSession({ surface: panelSurface });
    }
  });

  // While the agent is still working, keep the session open so output and
  // tool calls survive a hide. Once it's idle, close to release redirects.
  panel.handlers.advise("panel:hide", (next) => {
    next();
    if (session && !panel.processing) {
      session.close();
      session = null;
    }
  });

  panel.handlers.advise("panel:reset", (next) => {
    next();
    if (session) {
      session.close();
      session = null;
    }
  });

  // Picks up turns triggered indirectly (e.g. /skill:foo → agent:submit).
  bus.on("agent:processing-start", () => {
    if (panel.active && !panel.processing) panel.setActive();
  });

  bus.on("agent:processing-done", () => {
    if (panel.active) panel.setDone();
  });
}
