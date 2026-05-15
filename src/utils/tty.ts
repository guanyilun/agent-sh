import { execSync } from "child_process";

/**
 * libuv's setRawMode(true) keeps OPOST on, so the kernel rewrites \n to
 * \r\n. TUIs over ssh (e.g. emacs -nw) emit relative moves like "\n\n\n\b\b"
 * assuming a raw path — with OPOST on, \n snaps the cursor to col 0 and
 * subsequent text lands in the wrong column. Call after every setRawMode(true).
 */
export function clearOpost(): void {
  if (!process.stdin.isTTY) return;
  try {
    execSync("stty -opost", { stdio: "inherit" });
  } catch { /* best effort */ }
}
