/**
 * Overlay agent extension.
 *
 * Provides a hotkey (Ctrl+]) to summon the agent from anywhere — even
 * inside vim, htop, or ssh. Renders a full-screen response view by
 * holding stdout (suppresses both PTY and TUI output), then returns
 * to the previous program on dismiss.
 *
 * Flow:
 *   1. Ctrl+] → input bar at bottom of screen
 *   2. Type query, Enter → hold stdout, clear screen, submit
 *   3. Response streams directly to stdout (TUI renderer is suppressed)
 *   4. On completion → "Ctrl+] to dismiss" prompt
 *   5. Ctrl+] → release stdout, Ctrl+L to PTY to force program redraw
 *
 * Usage:
 *   agent-sh -e ./examples/extensions/overlay-agent.ts
 *
 *   # Or copy to ~/.agent-sh/extensions/ for permanent use:
 *   cp examples/extensions/overlay-agent.ts ~/.agent-sh/extensions/
 */
import type { ExtensionContext } from "agent-sh/types";

const TRIGGER = "\x1d"; // Ctrl+]
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const CYAN = "\x1b[36m";

type Phase = "idle" | "input" | "responding" | "done";

export default function activate({ bus }: ExtensionContext): void {
  let phase: Phase = "idle";
  let buffer = "";
  let cursor = 0;
  let renderTimer: ReturnType<typeof setTimeout> | null = null;

  // ── Input bar rendering ───────────────────────────────────

  function renderInputBar(): void {
    const cols = process.stdout.columns || 80;
    const rows = process.stdout.rows || 24;

    process.stdout.write("\x1b7"); // save cursor
    process.stdout.write(`\x1b[${rows};1H`); // move to bottom

    const label = "\x1b[7m agent \x1b[0m ";
    const maxInput = cols - 9;
    const displayBuf = buffer.length > maxInput
      ? buffer.slice(buffer.length - maxInput)
      : buffer;

    process.stdout.write("\x1b[2K" + label + displayBuf);

    const displayCursor = cursor - (buffer.length - displayBuf.length);
    process.stdout.write(`\x1b[${rows};${9 + displayCursor}H`);
  }

  function clearInputBar(): void {
    const rows = process.stdout.rows || 24;
    process.stdout.write(`\x1b[${rows};1H\x1b[2K`);
    process.stdout.write("\x1b8"); // restore cursor
  }

  // ── Phase transitions ─────────────────────────────────────

  function activate_overlay(): void {
    phase = "input";
    buffer = "";
    cursor = 0;
    renderInputBar();
  }

  function submit(): void {
    const query = buffer.trim();
    if (!query) { dismiss(); return; }

    phase = "responding";
    clearInputBar();

    // Hold stdout — suppresses both PTY output AND TUI renderer
    bus.emit("shell:stdout-hold", {});

    // Clear screen and show query header
    const cols = process.stdout.columns || 80;
    process.stdout.write("\x1b[2J\x1b[H");
    process.stdout.write(`${CYAN}${BOLD}❯${RESET} ${query}\n`);
    process.stdout.write(`${DIM}${"─".repeat(cols)}${RESET}\n`);

    bus.emit("agent:submit", { query });
  }

  function dismiss(): void {
    if (renderTimer) { clearTimeout(renderTimer); renderTimer = null; }

    const wasActive = phase === "responding" || phase === "done";
    phase = "idle";
    buffer = "";
    cursor = 0;

    if (wasActive) {
      // Release stdout — TUI renderer and PTY output resume
      bus.emit("shell:stdout-release", {});

      // Force the foreground program to redraw (Ctrl+L)
      bus.emit("shell:pty-write", { data: "\x0c" });
    } else {
      clearInputBar();
    }
  }

  // ── Input handling ────────────────────────────────────────

  function handleKey(data: string): void {
    let i = 0;
    while (i < data.length) {
      const ch = data[i]!;
      const code = ch.charCodeAt(0);

      // Escape (bare) → cancel
      if (ch === "\x1b" && data[i + 1] == null) { dismiss(); return; }
      // Ctrl+] → cancel
      if (ch === TRIGGER) { dismiss(); return; }
      // Ctrl+C → cancel
      if (code === 0x03) { dismiss(); return; }

      // Escape sequence → arrows
      if (ch === "\x1b") {
        i++;
        const next = data[i];
        if (next === "[" || next === "O") {
          i++;
          while (i < data.length && data.charCodeAt(i) >= 0x20 && data.charCodeAt(i) < 0x40) i++;
          const final = data[i]; i++;
          if (final === "C" && cursor < buffer.length) { cursor++; renderInputBar(); }
          if (final === "D" && cursor > 0) { cursor--; renderInputBar(); }
          if (final === "H") { cursor = 0; renderInputBar(); }
          if (final === "F") { cursor = buffer.length; renderInputBar(); }
        } else { i++; }
        continue;
      }

      // Enter → submit
      if (ch === "\r") { submit(); return; }

      // Backspace
      if (ch === "\x7f" || ch === "\b") {
        if (cursor > 0) {
          buffer = buffer.slice(0, cursor - 1) + buffer.slice(cursor);
          cursor--;
          renderInputBar();
        }
        i++; continue;
      }

      // Readline shortcuts
      if (code === 0x01) { cursor = 0; renderInputBar(); i++; continue; }
      if (code === 0x05) { cursor = buffer.length; renderInputBar(); i++; continue; }
      if (code === 0x15) { buffer = ""; cursor = 0; renderInputBar(); i++; continue; }
      if (code === 0x0b) { buffer = buffer.slice(0, cursor); renderInputBar(); i++; continue; }

      // Other control → ignore
      if (code < 0x20) { i++; continue; }

      // Printable
      buffer = buffer.slice(0, cursor) + ch + buffer.slice(cursor);
      cursor++;
      renderInputBar();
      i++;
    }
  }

  // ── Bus wiring ────────────────────────────────────────────

  // Re-render input bar after PTY output (foreground program redraws over it)
  bus.on("shell:pty-data", () => {
    if (phase !== "input") return;
    if (renderTimer) clearTimeout(renderTimer);
    renderTimer = setTimeout(() => {
      renderTimer = null;
      if (phase === "input") renderInputBar();
    }, 16);
  });

  // Stream response text directly to stdout (TUI renderer is suppressed)
  bus.on("agent:response-chunk", (e) => {
    if (phase !== "responding") return;
    for (const block of e.blocks) {
      if (block.type === "text" && block.text) {
        process.stdout.write(block.text);
      }
    }
  });

  // Tool call status — show compact one-liners
  bus.on("agent:tool-started", (e) => {
    if (phase !== "responding") return;
    process.stdout.write(`\n${DIM}▶ ${e.title}${RESET}`);
    if (e.displayDetail) process.stdout.write(`${DIM} ${e.displayDetail}${RESET}`);
  });

  bus.on("agent:tool-completed", (e) => {
    if (phase !== "responding") return;
    const mark = e.exitCode === 0 ? " ✓" : ` ✗ exit ${e.exitCode}`;
    process.stdout.write(`${DIM}${mark}${RESET}\n`);
  });

  // When agent finishes, show dismiss prompt
  bus.on("agent:processing-done", () => {
    if (phase === "responding") {
      phase = "done";
      const cols = process.stdout.columns || 80;
      process.stdout.write(`\n${DIM}${"─".repeat(cols)}${RESET}\n`);
      process.stdout.write(`${DIM}  Press Ctrl+] to return${RESET}\n`);
    }
  });

  // Intercept input: activate on trigger, capture while active
  bus.onPipe("input:intercept", (payload) => {
    // Done phase: any dismiss key returns to program
    if (phase === "done") {
      if (payload.data === TRIGGER || payload.data === "\x1b" || payload.data === "\x03") {
        dismiss();
      }
      return { ...payload, consumed: true };
    }

    // Input phase: editing
    if (phase === "input") {
      handleKey(payload.data);
      return { ...payload, consumed: true };
    }

    // Responding phase: only Ctrl+C to cancel agent
    if (phase === "responding") {
      if (payload.data === "\x03") {
        bus.emit("agent:cancel-request", {});
      }
      return { ...payload, consumed: true };
    }

    // Idle: trigger activates overlay
    if (payload.data === TRIGGER) {
      activate_overlay();
      return { ...payload, consumed: true };
    }

    return payload;
  });
}
