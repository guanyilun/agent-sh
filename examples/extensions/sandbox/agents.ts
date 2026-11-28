/** A second sandbox around each agent's shell commands (2026-11-27).
 *
 *  The run's OS sandbox wraps the whole run, the agent-sh process included, so it cannot hide what that process
 *  needs (the provider keys, the codex sign-in, the run's own transcripts) or cut the network the model calls use.
 *  Inside bubblewrap a nested bubblewrap can, per command: credentials and other runs' records are hidden, writes are
 *  limited to the agent's own write roots (so the program's state/ is read-only to it), and with `net: false` the
 *  command has no network.  The model calls, made by agent-sh outside the nested sandbox, are unaffected. */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

export interface AgentBox { write: string[]; net: boolean; hide: string[]; reveal: string[] }

const real = (p: string) => { try { return fs.realpathSync(p); } catch { return undefined; } };

/** What no agent needs and every agent could otherwise read: credentials, sign-ins, agent-sh's own homes (keys,
 *  transcripts of every run, shell history), Claude Code's files.  `reveal` re-exposes read-only what agents use. */
export function defaultAgentHides(agentShHome: string, home = os.homedir()): { hide: string[]; reveal: string[] } {
  const candidates = [
    agentShHome, path.join(home, ".agent-sh"), path.join(home, ".agent-sh-dev"),
    path.join(home, ".codex"), path.join(home, ".ssh"), path.join(home, ".gnupg"), path.join(home, ".aws"),
    path.join(home, ".netrc"), path.join(home, ".git-credentials"), path.join(home, ".config", "gh"),
    path.join(home, ".claude"),
  ];
  const hide = [...new Set(candidates.flatMap(p => [p, real(p)]).filter((p): p is string => !!p && fs.existsSync(p)))];
  const reveal = [path.join(home, ".claude", "skills")].map(p => real(p)).filter((p): p is string => !!p);
  return { hide, reveal };
}

export function probeNested(bwrap: string): boolean {
  const r = spawnSync(bwrap, ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--unshare-net", "true"], { timeout: 10_000 });
  return r.status === 0;
}

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The command line that runs `command` (bash) inside the agent's box. */
export function wrapCommand(bwrap: string, box: AgentBox, cwd: string, command: string): string {
  const args = ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--bind", "/tmp", "/tmp", "--die-with-parent"];
  for (const w of box.write) if (fs.existsSync(w)) args.push("--bind", w, w);
  if (!box.net) args.push("--unshare-net");
  const emptied: string[] = [];
  for (const h of box.hide) {
    if (box.write.some(w => w === h || w.startsWith(h + path.sep))) continue;   // never hide what the agent must write
    let st: fs.Stats | undefined;
    try { st = fs.statSync(h); } catch { continue; }
    if (st.isDirectory()) { args.push("--tmpfs", h); emptied.push(h); } else args.push("--ro-bind", "/dev/null", h);
  }
  // reveals go into the emptied dirs while they are still writable (mount points are created), then those turn read-only
  for (const r of box.reveal) if (fs.existsSync(r)) args.push("--ro-bind", r, r);
  for (const h of emptied) args.push("--remount-ro", h);
  args.push("--chdir", cwd);
  return `exec ${quote(bwrap)} ${args.map(quote).join(" ")} -- bash -c ${quote(command)}`;
}
