import { execSync } from "node:child_process";

// rawOutput=false keeps OPOST on; renderers emitting lone `\n` staircase without it.
export function applyOutputMode(rawOutput: boolean | undefined): void {
  if (!process.stdin.isTTY) return;
  try {
    execSync(`stty ${rawOutput ? "-opost" : "opost"}`, { stdio: "inherit" });
  } catch { /* best effort */ }
}
