/** Events owned by the shell subsystem. */
declare module "../core/event-bus.js" {
  interface BusEvents {
    "shell:command-start": { command: string; cwd: string };
    "shell:command-done": {
      command: string;
      output: string;
      outputRaw: string;
      cwd: string;
      exitCode: number | null;
    };
    "shell:cwd-change": { cwd: string };
    "shell:foreground-busy": { busy: boolean };
    "shell:agent-exec-start": Record<string, never>;
    "shell:agent-exec-done": Record<string, never>;

    /** Mark the next user-emitted shell command as excluded from <shell_events>. */
    "shell:user-exec-exclude-next": Record<string, never>;

    "shell:pty-data": { raw: string };
    "shell:pty-write": { data: string };
    "shell:pty-resize": { cols: number; rows: number };

    "shell:host-write": { data: string };

    "shell:buffer-request": Record<string, never>;
    "shell:buffer-snapshot": {
      text: string;
      altScreen: boolean;
      cursor: { x: number; y: number };
    };

    "shell:stdout-hold": Record<string, never>;
    "shell:stdout-release": Record<string, never>;
    "shell:stdout-show": Record<string, never>;
    "shell:stdout-hide": Record<string, never>;

    /** Sync pipe: handled=true suppresses default redraw. */
    "shell:redraw-prompt": {
      cwd: string;
      kind: "fresh" | "redraw";
      handled: boolean;
    };

    /** Async pipe: extension → user's PTY. */
    "shell:exec-request": {
      command: string;
      output: string;
      cwd: string;
      exitCode: number | null;
      done: boolean;
    };

    "input-mode:register": import("./host-types.js").InputModeConfig;
    "input:keypress": { key: string };
    "input:intercept": { data: string; consumed: boolean };
    "input:redraw": Record<string, never>;

    "compositor:write": { stream: string; text: string };

    /** Sync pipe: extensions append items. */
    "autocomplete:request": {
      buffer: string;
      /** "/backend" or null if not a command. */
      command: string | null;
      /** Text after the command name, or null. */
      commandArgs: string | null;
      items: { name: string; description: string }[];
    };
  }
}

export {};
