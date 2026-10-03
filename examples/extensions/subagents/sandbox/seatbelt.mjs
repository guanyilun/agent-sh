import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const HOME_READ_ONLY = ["settings.json", "keys.json", "extensions", "agents", "workflows"];

// Seatbelt matches resolved paths (/tmp is /private/tmp), so resolve what exists.
const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const str = (p) => `"${String(p).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

export function seatbeltProfile({ write = [], hide = [], home }) {
  // The user's temp area: $TMPDIR (…/T) and its siblings like the cache dir (…/C).
  const temp = path.dirname(real(os.tmpdir()));
  const writable = [...write.map(real), home && real(home), temp, "/private/tmp"].filter(Boolean);
  const lines = [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    `(allow file-write* ${writable.map((p) => `(subpath ${str(p)})`).join(" ")}`,
    '  (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty") (literal "/dev/dtracehelper")',
    '  (regex #"^/dev/fd/") (regex #"^/dev/ttys"))',
  ];
  if (home) lines.push(`(deny file-write* ${HOME_READ_ONLY.map((n) => `(subpath ${str(path.join(real(home), n))})`).join(" ")})`);
  if (hide.length) lines.push(`(deny file-read* file-write* ${hide.map((h) => `(subpath ${str(real(h))})`).join(" ")})`);
  return lines.join("\n");
}

export function probeSeatbelt(sandboxExec) {
  if (!fs.existsSync(sandboxExec)) return { ok: false, reason: `${sandboxExec} not found` };
  const r = spawnSync(sandboxExec, ["-p", "(version 1)(allow default)", "/usr/bin/true"], { encoding: "utf8", timeout: 10_000 });
  if (r.status === 0) return { ok: true };
  return { ok: false, reason: `${sandboxExec} failed: ${(r.stderr || r.error?.message || `exit ${r.status}`).trim().split("\n")[0]}` };
}

export function seatbeltArgv(sandboxExec, policy, argv) {
  for (const w of policy.write) fs.mkdirSync(w, { recursive: true });
  return [sandboxExec, "-p", seatbeltProfile(policy), "/usr/bin/env", "SBX_SANDBOXED=1", "SBX_SANDBOX_KIND=seatbelt", ...argv];
}
