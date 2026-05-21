/**
 * Augments core's BusEvents with the events owned by the shell
 * subsystem (PTY, input handler, compositor, autocomplete).
 */

declare module "../core/event-bus.js" {
  interface BusEvents {
    // ── Shell lifecycle ──────────────────────────────────────────
    "shell:command-start": { command: string; cwd: string };
    "shell:command-done": {
      command: string;
      output: string;
      cwd: string;
      exitCode: number | null;
    };
    "shell:cwd-change": { cwd: string };
    "shell:foreground-busy": { busy: boolean };
    "shell:agent-exec-start": Record<string, never>;
    "shell:agent-exec-done": Record<string, never>;

    // ── PTY I/O ──────────────────────────────────────────────────
    "shell:pty-data": { raw: string };
    "shell:pty-write": { data: string };
    "shell:pty-resize": { cols: number; rows: number };

    // ── Terminal buffer snapshot (request/response via bus) ─────
    "shell:buffer-request": Record<string, never>;
    "shell:buffer-snapshot": {
      text: string;
      altScreen: boolean;
      cursor: { x: number; y: number };
    };

    // ── Stdout gating (ref-counted hold/release; force show/hide) ─
    "shell:stdout-hold": Record<string, never>;
    "shell:stdout-release": Record<string, never>;
    "shell:stdout-show": Record<string, never>;
    "shell:stdout-hide": Record<string, never>;

    // ── Prompt redraw (sync pipe: handled=true suppresses) ──────
    "shell:redraw-prompt": {
      cwd: string;
      kind: "fresh" | "redraw";
      handled: boolean;
    };

    // ── Shell exec (async pipe: extension → user's PTY) ─────────
    "shell:exec-request": {
      command: string;
      output: string;
      cwd: string;
      exitCode: number | null;
      done: boolean;
    };

    // ── Input modes / keypress / intercept ──────────────────────
    "input-mode:register": import("./host-types.js").InputModeConfig;
    "input:keypress": { key: string };
    "input:intercept": { data: string; consumed: boolean };

    // ── Compositor surface writes ───────────────────────────────
    "compositor:write": { stream: string; text: string };

    // ── Autocomplete (sync pipe: extensions append items) ───────
    "autocomplete:request": {
      buffer: string;
      /** Parsed slash command name (e.g. "/backend"), or null if not a command. */
      command: string | null;
      /** Text after the command name (e.g. "clau" for "/backend clau"), or null. */
      commandArgs: string | null;
      items: { name: string; description: string }[];
    };
  }
}

export {};
