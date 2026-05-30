import { execSync } from "node:child_process";

/** pi-tui drives a raw terminal and emits its own `\r`, so agent-sh's Shell
 *  clears OPOST on boot. Renderers that emit lone `\n` (Ink, most libraries)
 *  need OPOST on or they staircase. The substrate asserts the mode the active
 *  renderer declares, so renderer authors only set a capability flag. */
export function applyOutputMode(rawOutput: boolean | undefined): void {
  if (!process.stdin.isTTY) return;
  try {
    execSync(`stty ${rawOutput ? "-opost" : "opost"}`, { stdio: "inherit" });
  } catch { /* best effort */ }
}
