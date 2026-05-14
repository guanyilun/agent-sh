import * as fs from "fs";
import * as path from "path";
import type { ShellStrategy, PrepareSpawnOpts, ShellSpawnConfig } from "./types.js";

const OSC7_CMD = 'printf "\\e]7;file://%s%s\\a" "$(hostname)" "$PWD"';
const TITLE_CMD = 'printf "\\e]0;⚡ agent-sh: %s\\a" "${PWD/#$HOME/~}"';

export const zshStrategy: ShellStrategy = {
  name: "zsh",

  matches(shellPath: string): boolean {
    return path.basename(shellPath).includes("zsh");
  },

  prepareSpawn(opts: PrepareSpawnOpts): ShellSpawnConfig {
    const { tmpDirRoot, instanceTag, showIndicator, env, userHome } = opts;

    // Use ZDOTDIR to source user's real config, then append our hooks via
    // precmd_functions (additive — doesn't clobber p10k/omz).
    const tmpDir = fs.mkdtempSync(path.join(tmpDirRoot, "agent-sh-"));
    const userZdotdir = env.ZDOTDIR || env.HOME || userHome;
    const promptMarker = `printf "\\e]9999;${instanceTag};PROMPT\\a"`;

    const lines = [
      `ZDOTDIR="${userZdotdir}"`,
      `[ -f "${userZdotdir}/.zshrc" ] && source "${userZdotdir}/.zshrc"`,
      "",
      "# agent-sh hooks (invisible OSC sequences for cwd + prompt detection)",
      "__agent_sh_precmd() {",
      `  ${OSC7_CMD}`,
      `  ${promptMarker}`,
      ...(showIndicator ? [`  ${TITLE_CMD}`] : []),
      "}",
      "precmd_functions+=(__agent_sh_precmd)",
      "",
      "# Preexec hook: emit actual command text so agent-sh can track",
      "# history-recalled and tab-completed commands accurately",
      "__agent_sh_preexec() {",
      `  printf "\\e]9997;${instanceTag};%s\\a" "$1"`,
      "}",
      "preexec_functions+=(__agent_sh_preexec)",
      "",
      "# End-of-prompt marker via zle-line-init (fires after prompt is rendered)",
      "# Chain onto existing widget (p10k uses zle-line-init) rather than clobbering",
      'if (( ${+widgets[zle-line-init]} )); then',
      "  zle -A zle-line-init __agent_sh_orig_line_init",
      "  __agent_sh_line_init() {",
      "    zle __agent_sh_orig_line_init",
      `    printf "\\e]9998;${instanceTag};READY\\a"`,
      "  }",
      "else",
      "  __agent_sh_line_init() {",
      `    printf "\\e]9998;${instanceTag};READY\\a"`,
      "  }",
      "fi",
      "zle -N zle-line-init __agent_sh_line_init",
      "",
      "# Hidden widget to trigger prompt redraw from Node.js side",
      "# Bound to an unused escape sequence that no real key produces",
      "__agent_sh_redraw() {",
      "  zle reset-prompt",
      "}",
      "zle -N __agent_sh_redraw",
      "bindkey '\\e[9999~' __agent_sh_redraw",
    ];

    fs.writeFileSync(path.join(tmpDir, ".zshrc"), lines.join("\n") + "\n");

    return {
      args: ["--no-globalrcs"],
      envOverrides: { ZDOTDIR: tmpDir },
      tmpDir,
    };
  },

  envCaptureCommand(): string {
    return "source ~/.zshrc 2>/dev/null; env -0";
  },

  redrawEscape(): string {
    return "\x1b[9999~";
  },
};
