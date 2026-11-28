/** Sandbox for unattended runs: a tool-call guard, plus an OS sandbox around `agent-sh run` files; see README.md. */
import type { ExtensionContext } from "agent-sh/types";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { armGuard, makeVerdict } from "./guard.js";
import { defaultAgentHides, probeNested, wrapCommand } from "./agents.js";
import { probeSeatbelt, seatbeltArgv, type Probe } from "./seatbelt.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = process.env.AGENT_SH_HOME ? path.resolve(process.env.AGENT_SH_HOME) : path.join(os.homedir(), ".agent-sh");
const OPTIONS = ["write", "hide", "policy", "os", "net"];
const OS_MODES = ["required", "preferred", "off"];

interface SandboxConfig {
  write?: string[];
  hide?: string[];
  /** One rules file, or several (e.g. the team's generic one and the project's own); all apply. */
  policy?: string | string[];
  os?: string;
  net?: boolean;
}

type Backend = Probe & { kind?: "bubblewrap" | "landlock" | "seatbelt"; path?: string };

export default function activate(ctx: ExtensionContext): void {
  const run = ctx.list().includes("run:config") ? ctx.call("run:config") as { base: string; sandbox?: SandboxConfig } : undefined;
  const sb = run?.sandbox;
  // Set by the wrappers themselves, so it's only true inside one.
  const isolated = process.env.SBX_SANDBOXED === "1";
  const agentDefaults = defaultAgentHides(HOME);
  const arm = (write: string[], hide: string[], policy: string[]) => {
    armGuard(ctx, makeVerdict({ write, hide: [...hide, ...agentDefaults.hide], policy, reveal: agentDefaults.reveal }));
    const kind = isolated ? `on (${process.env.SBX_SANDBOX_KIND || "bubblewrap"})` : "off";
    ctx.bus.emit("ui:info", { message: `sandbox guard armed (write roots: ${write.join(":") || "none"}; hidden: ${hide.length}; policy: ${policy.join(":") || "none"}; os sandbox: ${kind})` });
  };

  if (!run || !sb) {
    // For callers that start agent-sh themselves.
    const list = (v?: string) => (v || "").split(":").filter(Boolean);
    if (process.env.SBX_GUARD === "1") arm(list(process.env.SBX_WRITE_ROOTS), list(process.env.SBX_HIDE), list(process.env.SBX_POLICY));
    return;
  }

  const abs = (p: string) => path.resolve(run.base, p);
  const write = (sb.write ?? []).map(abs);
  const hide = (sb.hide ?? []).map(abs);
  const mode = sb.os ?? "preferred";
  let backend: Backend | undefined;
  const osSandbox = () => (backend ??= pickBackend());

  // Inside the run's bubblewrap each agent shell command runs in its own nested bubblewrap (agents.ts).  Advised
  // before the guard is armed, so the guard (the later, outer advice) checks the agent's own command, not the wrapper.
  if (isolated && process.env.SBX_SANDBOX_KIND === "bubblewrap") {
    const bwrap = process.env.SBX_BWRAP || "/usr/bin/bwrap";
    if (probeNested(bwrap)) {
      const net = sb.net !== false;
      ctx.advise("tool:bash", (next, args: Record<string, unknown>, ...rest: unknown[]) => {
        const { agentWrite, ...plain } = args;
        const box = { write: Array.isArray(agentWrite) ? agentWrite as string[] : write, net,
                      hide: [...hide, ...agentDefaults.hide], reveal: agentDefaults.reveal };
        return next({ ...plain, command: wrapCommand(bwrap, box, ctx.call("cwd") as string, String(plain.command ?? "")) }, ...rest);
      });
      ctx.bus.emit("ui:info", { message: `agent commands sandboxed: ${agentDefaults.hide.length} credential and record paths hidden; network ${net ? "on" : "off"}` });
    } else {
      ctx.bus.emit("ui:info", { message: "nested bubblewrap not usable here: agents' commands share the run's sandbox (credentials hidden from their file tools only)" });
    }
  }

  const policies = [sb.policy ?? []].flat().filter((p): p is string => typeof p === "string").map(abs);
  arm(write, hide, policies);

  ctx.bus.onPipe("run:checks", (p) => {
    p.handled.push("sandbox");
    for (const key of Object.keys(sb)) if (!OPTIONS.includes(key)) p.problems.push(`config.sandbox.${key} isn't a sandbox option (${OPTIONS.join(", ")}).`);
    if (!OS_MODES.includes(mode)) p.problems.push(`config.sandbox.os must be one of ${OS_MODES.join(", ")}; got ${JSON.stringify(sb.os)}.`);
    if (sb.policy !== undefined && !(typeof sb.policy === "string" || (Array.isArray(sb.policy) && sb.policy.every(p => typeof p === "string"))))
      p.problems.push("config.sandbox.policy must be a path or a list of paths.");
    if (sb.net !== undefined && typeof sb.net !== "boolean") p.problems.push("config.sandbox.net must be true or false (false: agents' own commands have no network; model calls are unaffected).");
    if (isolated) return p;
    // net: false and hiding credentials from agents' commands need a nested bubblewrap around each command
    if (mode === "off") {
      if (sb.net === false) p.problems.push("config.sandbox.net: false needs the OS sandbox (bubblewrap) to cut agents' commands off; os is \"off\".");
      return p;
    }
    const { ok, reason } = osSandbox();
    const nested = ok && osSandbox().kind === "bubblewrap";
    if (sb.net === false && !nested && mode === "required")
      p.problems.push(`config.sandbox.net: false needs bubblewrap (a sandbox per agent command); here: ${ok ? osSandbox().kind : reason}.`);
    else if (ok && !nested)
      ctx.bus.emit("ui:info", { message: `agents' commands are not sandboxed separately (${osSandbox().kind}): credentials are hidden from their file tools only${sb.net === false ? ", and they keep the network" : ""}.` });
    if (!ok && mode === "required") p.problems.push(`config.sandbox.os is "required" but no OS sandbox is usable here (${reason}).`);
    else if (!ok) ctx.bus.emit("ui:info", { message: `no OS sandbox (${reason}); running with the guard only.` });
    return p;
  });

  ctx.bus.onPipe("run:wrap", (p) => {
    if (mode === "off" || isolated) return p;
    const b = osSandbox();
    if (!b.ok) return p;
    // Bubblewrap gives the run a private /tmp, so a run file or write dir there would vanish inside it.
    // Checked here because run:checks only fires inside the restarted run.
    if (b.kind === "bubblewrap") {
      const inTmp = (dir: string) => dir === "/tmp" || dir.startsWith("/tmp/");
      const bad = [run.base, ...write].filter(inTmp);
      if (bad.length) {
        console.error(`agent-sh run: ${bad.join(", ")} under /tmp, which is private inside the bubblewrap sandbox; put the run file and write dirs elsewhere.`);
        process.exit(2);
      }
    }
    if (b.kind === "seatbelt") return { ...p, argv: seatbeltArgv(b.path!, { write, hide, home: HOME }, p.argv) };
    const wrapper = b.kind === "landlock" ? [b.path!, path.join(HERE, "landlock.py")] : [path.join(HERE, "sandbox.sh")];
    const args = [...wrapper, "--home", HOME, ...write.flatMap(w => ["--rw", w]), ...hide.flatMap(h => ["--hide", h])];
    return { ...p, argv: [...args, "--", ...p.argv] };
  });
}

// Run it once: some systems install bwrap but block unprivileged user namespaces.
export function probeBwrap(bwrap: string): Probe {
  if (!fs.existsSync(bwrap)) return { ok: false, reason: `${bwrap} not found` };
  const r = spawnSync(bwrap, ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--unshare-pid", "true"], { encoding: "utf8", timeout: 10_000 });
  if (r.status === 0) return { ok: true };
  return { ok: false, reason: `${bwrap} failed: ${(r.stderr || r.error?.message || `exit ${r.status}`).trim().split("\n")[0]}` };
}

export function probeLandlock(python: string): Probe {
  if (process.env.SBX_LANDLOCK === "off") return { ok: false, reason: "disabled (SBX_LANDLOCK=off)" };
  const r = spawnSync(python, [path.join(HERE, "landlock.py"), "--probe"], { encoding: "utf8", timeout: 10_000 });
  if (r.status === 0) return { ok: true };
  if (r.error) return { ok: false, reason: `${python} not usable (${r.error.message})` };
  return { ok: false, reason: (r.stderr || `exit ${r.status}`).trim().split("\n").pop()!.replace(/^landlock: /, "") };
}

function pickBackend(): Backend {
  if (process.platform === "linux") {
    const bwrap = process.env.SBX_BWRAP || "/usr/bin/bwrap";
    const b = probeBwrap(bwrap);
    if (b.ok) return { ...b, kind: "bubblewrap", path: bwrap };
    const python = process.env.SBX_PYTHON || "python3";
    const l = probeLandlock(python);
    if (l.ok) return { ...l, kind: "landlock", path: python };
    return { ok: false, reason: `bubblewrap: ${b.reason}; landlock: ${l.reason}` };
  }
  if (process.platform === "darwin") {
    const exec = process.env.SBX_SANDBOX_EXEC || "/usr/bin/sandbox-exec";
    return { ...probeSeatbelt(exec), kind: "seatbelt", path: exec };
  }
  return { ok: false, reason: `no OS sandbox on ${process.platform}` };
}
