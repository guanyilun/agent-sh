import * as fs from "fs";
import * as path from "path";
import type { ShellStrategy, PrepareSpawnOpts, ShellSpawnConfig } from "./types.js";

// $hostname is set by fish itself — avoids shelling out to hostname(1), which
// isn't installed everywhere (e.g. Arch without inetutils).
const OSC7_CMD = 'printf "\\e]7;file://%s%s\\a" "$hostname" "$PWD"';
const TITLE_CMD =
  'printf "\\e]0;⚡ agent-sh: %s\\a" (string replace -- "$HOME" "~" "$PWD")';

export const fishStrategy: ShellStrategy = {
  name: "fish",

  matches(shellPath: string): boolean {
    return path.basename(shellPath).includes("fish");
  },

  prepareSpawn(opts: PrepareSpawnOpts): ShellSpawnConfig {
    const { tmpDirRoot, instanceTag, showIndicator } = opts;

    // Layer hooks via `-C` so they run after the user's config — our wrapper
    // around fish_prompt needs to see the user's final definition.
    const tmpDir = fs.mkdtempSync(path.join(tmpDirRoot, "agent-sh-"));
    const initPath = path.join(tmpDir, "init.fish");
    const promptMarker = `printf "\\e]9999;${instanceTag};PROMPT\\a"`;

    const lines = [
      "# agent-sh hooks (invisible OSC sequences for cwd + prompt detection)",
      "function __agent_sh_precmd --on-event fish_prompt",
      `  ${OSC7_CMD}`,
      `  ${promptMarker}`,
      ...(showIndicator ? [`  ${TITLE_CMD}`] : []),
      "end",
      "",
      "# Preexec hook: emit actual command text so agent-sh can track",
      "# history-recalled and tab-completed commands accurately",
      "function __agent_sh_preexec --on-event fish_preexec",
      `  printf "\\e]9997;${instanceTag};%s\\a" "$argv"`,
      "end",
      "",
      "# End-of-prompt marker: wrap fish_prompt so READY fires after render",
      "if functions -q fish_prompt",
      "  functions --copy fish_prompt __agent_sh_orig_fish_prompt",
      "  function fish_prompt",
      "    __agent_sh_orig_fish_prompt",
      `    printf "\\e]9998;${instanceTag};READY\\a"`,
      "  end",
      "else",
      "  function fish_prompt",
      "    printf '%s> ' (prompt_pwd)",
      `    printf "\\e]9998;${instanceTag};READY\\a"`,
      "  end",
      "end",
      "",
      "# Redraw binding. fish 4 silently drops \\e[N~ outside the F-key table,",
      "# so we use CSI-u with a private-use codepoint (U+E028) instead.",
      "bind \\e\\[57400u 'commandline -f repaint' 2>/dev/null",
      "bind -M insert \\e\\[57400u 'commandline -f repaint' 2>/dev/null",
      "bind -M default \\e\\[57400u 'commandline -f repaint' 2>/dev/null",
    ];

    fs.writeFileSync(initPath, lines.join("\n") + "\n");

    return {
      args: ["-l", "-i", "-C", `source ${initPath}`],
      envOverrides: {},
      tmpDir,
    };
  },

  envCaptureCommand(): string {
    // `fish -l` already sources config.fish + conf.d, so no explicit source.
    return "env -0";
  },

  envCaptureFiles(env): string[] {
    const config = env.XDG_CONFIG_HOME || (env.HOME ? path.join(env.HOME, ".config") : undefined);
    if (!config) return [];
    return [path.join(config, "fish", "config.fish"), path.join(config, "fish", "conf.d")];
  },

  redrawEscape(): string {
    return "\x1b[57400u";
  },
};
