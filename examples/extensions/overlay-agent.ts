/**
 * Overlay agent extension.
 *
 * Provides a hotkey (Ctrl+\) to summon the agent from anywhere — even
 * inside vim, htop, or ssh. Composites a floating response box on top
 * of the current terminal content.
 *
 * Uses createRemoteSession() to route the full tui-renderer pipeline
 * (markdown, tool grouping, spinner, diffs) into the floating panel.
 *
 * Install:
 *   cp examples/extensions/overlay-agent.ts ~/.agent-sh/extensions/
 *
 * Or load directly:
 *   agent-sh -e ./examples/extensions/overlay-agent.ts
 *
 * Requires: npm install @xterm/headless@5.5.0 @xterm/addon-serialize@0.13.0
 */
import type { ExtensionContext, RemoteSession } from "agent-sh/types";
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

export default function activate(ctx: ExtensionContext): void {
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
    panel.setActive();
    session.submit(query);
  });

  panel.handlers.advise("panel:show", (_next) => {
    if (panel.active && !session) {
      session = createRemoteSession({ surface: panelSurface });
    }
  });

  // Keep the session alive while the agent is still working, even after
  // dismiss — so output keeps buffering and tools keep executing.
  panel.handlers.advise("panel:dismiss", (next) => {
    next();
    if (session && !panel.processing) {
      session.close();
      session = null;
    }
  });

  bus.on("agent:processing-done", () => {
    if (panel.active) panel.setDone();
  });
}
