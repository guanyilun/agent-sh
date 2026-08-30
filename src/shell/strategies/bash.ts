import * as fs from "fs";
import * as path from "path";
import type { ShellStrategy, PrepareSpawnOpts, ShellSpawnConfig } from "./types.js";

// $HOSTNAME is a bash builtin — avoids shelling out to hostname(1), which
// isn't installed everywhere (e.g. Arch without inetutils).
const OSC7_CMD = 'printf "\\e]7;file://%s%s\\a" "$HOSTNAME" "$PWD"';
const TITLE_CMD = 'printf "\\e]0;⚡ agent-sh: %s\\a" "${PWD/#$HOME/~}"';

export const bashStrategy: ShellStrategy = {
  name: "bash",

  matches(shellPath: string): boolean {
    return path.basename(shellPath).includes("bash");
  },

  prepareSpawn(opts: PrepareSpawnOpts): ShellSpawnConfig {
    const { tmpDirRoot, instanceTag, showIndicator, env, userHome } = opts;

    // Use --rcfile to source our wrapper, which sources the user's real
    // bashrc then appends our hooks. No HOME override needed.
    const tmpDir = fs.mkdtempSync(path.join(tmpDirRoot, "agent-sh-"));
    const home = env.HOME || userHome;
    const promptMarker = `printf "\\e]9999;${instanceTag};PROMPT\\a"`;

    const lines = [
      `[ -f "${home}/.bashrc" ] && source "${home}/.bashrc"`,
      "",
      "# agent-sh hooks (invisible OSC sequences for cwd + prompt detection)",
      "# Wrapped in a function because inlining printf \"...\" into",
      "# PROMPT_COMMAND=\"...\" breaks the outer quoting.",
      "__agent_sh_precmd() {",
      `  ${OSC7_CMD}`,
      `  ${promptMarker}`,
      ...(showIndicator ? [`  ${TITLE_CMD}`] : []),
      "  __agent_sh_preexec_ran=0",
      "}",
      `PROMPT_COMMAND="\${PROMPT_COMMAND%;}"`,
      `PROMPT_COMMAND="\${PROMPT_COMMAND:+\$PROMPT_COMMAND;}__agent_sh_precmd"`,
      "",
      "# Preexec hook via DEBUG trap: emit actual command text so agent-sh",
      "# can track history-recalled and tab-completed commands accurately.",
      "# Start latched (=1) so the trap stays inert through the rest of",
      "# rcfile sourcing — readline/history aren't loaded yet, and the case",
      "# + bind statements below would otherwise fire a phantom preexec with",
      "# an empty body. __agent_sh_precmd resets it to 0 before user input.",
      "__agent_sh_preexec_ran=1",
      "__agent_sh_emit_preexec() {",
      '  [[ $__agent_sh_preexec_ran == 1 ]] && return',
      '  [[ -n $COMP_LINE ]] && return',
      "  __agent_sh_preexec_ran=1",
      "  local this_cmd hist_cmd",
      `  hist_cmd=$(HISTTIMEFORMAT='' builtin history 1 | command sed 's/^ *[0-9]* *//')`,
      "  # history 1 carries the full typed line but goes stale when the user's",
      "  # PROMPT_COMMAND reloads history (history -c/-r). Trust it only when it",
      "  # matches the command bash is about to run; else use $BASH_COMMAND.",
      '  if [[ -n $hist_cmd && $hist_cmd == "$BASH_COMMAND"* ]]; then',
      "    this_cmd=$hist_cmd",
      "  else",
      "    this_cmd=$BASH_COMMAND",
      "  fi",
      `  printf '\\e]9997;${instanceTag};%s\\a' "$this_cmd"`,
      "}",
      "trap '__agent_sh_emit_preexec' DEBUG",
      "",
      "# End-of-prompt marker: append to PS1 (\\[...\\] marks it zero-width)",
      `case "$PS1" in *9998*) ;; *) PS1="\${PS1}\\[\\e]9998;${instanceTag};READY\\a\\]";; esac`,
      "",
      "# Mirrors the zsh \\e[9999~ reset-prompt widget — used by agent-sh",
      "# to repaint the prompt in place. All keymaps so `set -o vi` works.",
      `bind -m emacs '"\\e[9999~":redraw-current-line' 2>/dev/null`,
      `bind -m vi-insert '"\\e[9999~":redraw-current-line' 2>/dev/null`,
      `bind -m vi-command '"\\e[9999~":redraw-current-line' 2>/dev/null`,
    ];

    const rcPath = path.join(tmpDir, ".bashrc");
    fs.writeFileSync(rcPath, lines.join("\n") + "\n");

    return {
      args: ["--rcfile", rcPath],
      envOverrides: {},
      tmpDir,
    };
  },

  envCaptureCommand(): string {
    return "[ -f ~/.bashrc ] && source ~/.bashrc 2>/dev/null; env -0";
  },

  envCaptureFiles(env): string[] {
    const home = env.HOME;
    if (!home) return [];
    return [".bashrc", ".bash_profile", ".bash_login", ".profile"].map((f) => path.join(home, f));
  },

  redrawEscape(): string {
    return "\x1b[9999~";
  },
};
