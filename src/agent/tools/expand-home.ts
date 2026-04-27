import * as os from "node:os";

export function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return os.homedir() + p.slice(1);
  return p;
}
