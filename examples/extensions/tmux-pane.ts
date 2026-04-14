/**
 * Tmux side-pane extension.
 *
 * When running inside tmux, provides `/split` to open a side pane
 * where all agent output is rendered. The user's shell stays
 * undisturbed in the original pane. Uses the compositor to redirect
 * the "agent" stream to a tmux pane surface.
 *
 * The side pane runs `cat` to stay alive and accepts writes via its tty.
 *
 * Usage:
 *   # Load directly
 *   ash -e ./examples/extensions/tmux-pane.ts
 *
 *   # Or install permanently
 *   cp examples/extensions/tmux-pane.ts ~/.agent-sh/extensions/
 *
 * Commands:
 *   /split        — toggle side pane on/off
 *   /split open   — open the side pane
 *   /split close  — close the side pane
 */
import * as fs from "node:fs";
import { execSync, spawn, type ChildProcess } from "node:child_process";
import type { ExtensionContext, RenderSurface } from "agent-sh/types";

function inTmux(): boolean {
  return !!process.env.TMUX;
}

function tmux(...args: string[]): string {
  return execSync("tmux " + args.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(" "), { encoding: "utf-8" }).trim();
}

interface TmuxPane {
  paneId: string;
  tty: string;
  fd: fs.WriteStream;
  process: ChildProcess;
}

function createTmuxPane(widthPercent = 45, onError?: () => void): TmuxPane {
  // Split horizontally, get pane id and tty
  const output = tmux(
    "split-window", "-h",
    "-l", `${widthPercent}%`,
    "-P", "-F", "#{pane_id}",
    // Run cat to keep pane alive
    "cat",
  );
  const paneId = output.trim();

  // Small delay for pane to initialize its tty
  execSync("sleep 0.1");

  const tty = tmux("display-message", "-p", "-t", paneId, "#{pane_tty}");
  const fd = fs.createWriteStream(tty, { flags: "w" });

  // When the pane is killed externally, the fd gets an EIO error.
  // Trigger cleanup so the compositor stops routing to the dead surface.
  fd.on("error", () => { onError?.(); });

  // Get the cat process — we spawned it via tmux, so we don't have a
  // direct handle. We'll track the pane id for cleanup instead.
  const proc = spawn("true", [], { stdio: "ignore", detached: true });
  proc.unref();

  return { paneId, tty, fd, process: proc };
}

function getPaneWidth(paneId: string): number {
  try {
    return parseInt(tmux("display-message", "-p", "-t", paneId, "#{pane_width}"), 10) || 80;
  } catch {
    return 80;
  }
}

function killPane(pane: TmuxPane): void {
  try { pane.fd.end(); } catch { /* ignore */ }
  try { tmux("kill-pane", "-t", pane.paneId); } catch { /* ignore */ }
}

function createTmuxSurface(pane: TmuxPane): RenderSurface {
  // Cache pane width — refreshed on SIGWINCH via tmux, but we only
  // need to query it occasionally (not on every line).
  let cachedWidth = getPaneWidth(pane.paneId);
  let lastWidthCheck = Date.now();

  return {
    write(text: string): void {
      if (pane.fd.destroyed) return;
      try { pane.fd.write(text); } catch { /* pane may be gone */ }
    },
    writeLine(line: string): void {
      this.write(line + "\n");
    },
    get columns(): number {
      const now = Date.now();
      if (now - lastWidthCheck > 2000) {
        cachedWidth = getPaneWidth(pane.paneId);
        lastWidthCheck = now;
      }
      return cachedWidth;
    },
  };
}

export default function activate(ctx: ExtensionContext): void {
  const { bus, compositor, advise, registerCommand } = ctx;

  if (!inTmux()) return; // silently no-op outside tmux

  let pane: TmuxPane | null = null;
  let surface: RenderSurface | null = null;
  let restoreAgent: (() => void) | null = null;
  let restoreQuery: (() => void) | null = null;
  let restoreStatus: (() => void) | null = null;

  // In split mode, don't pause the shell — agent output goes to a
  // separate pane so the user can keep working.
  advise("shell:on-processing-start", (next) => {
    if (pane) return; // skip pause — user keeps their shell
    return next();
  });

  advise("shell:on-processing-done", (next) => {
    if (pane) return; // skip prompt redraw — already redrawn on query
    return next();
  });

  // Suppress response borders in the side pane — the pane itself
  // provides visual separation between queries.
  advise("tui:response-border", (next, position: string, width: number) => {
    if (pane) return null;
    return next(position, width);
  });

  function openSplit(): void {
    if (pane) return; // already open

    try {
      pane = createTmuxPane(45, () => destroyStalePane());
      surface = createTmuxSurface(pane);

      // Redirect all render streams to the side pane.
      restoreAgent = compositor.redirect("agent", surface);
      restoreQuery = compositor.redirect("query", surface);
      restoreStatus = compositor.redirect("status", surface);

      // Write a subtle header
      surface.writeLine("\x1b[2m── agent output ──\x1b[0m\n");

      bus.emit("ui:info", { message: "Side pane opened. Agent output redirected." });
    } catch (e) {
      bus.emit("ui:error", {
        message: `Failed to create tmux pane: ${e instanceof Error ? e.message : String(e)}`,
      });
      pane = null;
      surface = null;
    }
  }

  function closeSplit(): void {
    if (!pane) return;

    restoreAgent?.();
    restoreQuery?.();
    restoreStatus?.();
    restoreAgent = restoreQuery = restoreStatus = null;

    killPane(pane);
    pane = null;
    surface = null;

    bus.emit("ui:info", { message: "Side pane closed." });
  }

  function toggle(): void {
    if (pane) closeSplit();
    else openSplit();
  }

  registerCommand("split", "Toggle tmux side pane for agent output", (args) => {
    const cmd = args.trim().toLowerCase();
    if (cmd === "close") return closeSplit();
    if (cmd === "open") return openSplit();
    toggle();
  });

  // In split mode, give the user their shell prompt back immediately
  // after submitting a query — don't wait for the agent to finish.
  bus.on("agent:query", () => {
    if (!pane) return;
    // Send a newline to the PTY to trigger the shell's precmd hook,
    // which redraws the prompt. setImmediate ensures the query box
    // renders to the side pane first.
    setImmediate(() => {
      bus.emit("shell:pty-write", { data: "\n" });
    });
  });

  bus.on("agent:processing-done", () => {
    if (!pane) return;

    // Check if pane was closed externally
    try {
      tmux("display-message", "-p", "-t", pane.paneId, "#{pane_id}");
    } catch {
      destroyStalePane();
      return;
    }

    // Separate responses visually in the side pane
    surface?.writeLine("");
  });

  // Clean up on exit
  process.on("exit", () => {
    if (pane) killPane(pane);
  });

  function destroyStalePane(): void {
    restoreAgent?.();
    restoreQuery?.();
    restoreStatus?.();
    restoreAgent = restoreQuery = restoreStatus = null;
    try { pane?.fd.end(); } catch { /* ignore */ }
    pane = null;
    surface = null;
  }
}
