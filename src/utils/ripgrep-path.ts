import * as fs from "node:fs";
import { rgPath as bundledRgPath } from "@vscode/ripgrep";

/**
 * Resolve the ripgrep binary path. Prefers the version bundled via
 * @vscode/ripgrep (downloaded by its postinstall hook). Falls back to plain
 * "rg" so users with rg on PATH still work even if the postinstall failed
 * (offline install, blocked egress, etc.).
 */
export function resolveRgPath(): string {
  try {
    if (bundledRgPath && fs.existsSync(bundledRgPath)) return bundledRgPath;
  } catch {
    // fall through
  }
  return "rg";
}
