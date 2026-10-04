/** Sandbox for `agent-sh run` files: `config.sandbox` arms a tool-call guard and restarts the run inside an OS sandbox; see README.md. */
import type { ExtensionContext } from "agent-sh/types";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { armGuard, makeVerdict } from "./guard.js";
import { probeSeatbelt, seatbeltArgv, type Probe } from "./seatbelt.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = process.env.AGENT_SH_HOME ? path.resolve(process.env.AGENT_SH_HOME) : path.join(os.homedir(), ".agent-sh");
const OPTIONS = ["write", "hide", "policy", "os", "net"];
const OS_MODES = ["required", "preferred", "off"];

interface SandboxConfig {
  write?: string[];
  hide?: string[];
  policy?: string;
  os?: string;
  net?: boolean;
}

type Backend = Probe & { kind?: "bubblewrap" | "landlock" | "seatbelt"; path?: string };

export default function activate(ctx: ExtensionContext): void {
  const run = ctx.list().includes("run:config") ? ctx.call("run:config") as { base: string; sandbox?: SandboxConfig } : undefined;
  const sb = run?.sandbox;
  if (!run || !sb) return;

  const abs = (p: string) => path.resolve(run.base, p);
  const write = (sb.write ?? []).map(abs);
  const hide = (sb.hide ?? []).map(abs);
  const policy = sb.policy ? abs(sb.policy) : "";
  const mode = sb.os ?? "preferred";
  // Set by the wrappers themselves, so it's only true once one is really around this process.
  const isolated = process.env.SBX_SANDBOXED === "1";
  let backend: Backend | undefined;
  const osSandbox = () => (backend ??= pickBackend());

  armGuard(ctx, makeVerdict({ write, hide, policy }));
  const kind = isolated ? `on (${process.env.SBX_SANDBOX_KIND || "bubblewrap"})` : "off";
  ctx.bus.emit("ui:info", { message: `sandbox guard armed (write roots: ${write.join(":") || "none"}; hidden: ${hide.length}; policy: ${policy || "none"}; os sandbox: ${kind})` });

  ctx.bus.onPipe("run:checks", (p) => {
    p.handled.push("sandbox");
    for (const key of Object.keys(sb)) if (!OPTIONS.includes(key)) p.problems.push(`config.sandbox.${key} isn't a sandbox option (${OPTIONS.join(", ")}).`);
    if (!OS_MODES.includes(mode)) p.problems.push(`config.sandbox.os must be one of ${OS_MODES.join(", ")}; got ${JSON.stringify(sb.os)}.`);
    // The whole run is one process that must reach the model, so cutting its network can't work yet.
    if (sb.net === false) p.problems.push("config.sandbox.net: false isn't supported yet: the run itself needs the network to reach the model. Cutting the network for agents' commands needs per-agent isolation.");
    if (isolated || mode === "off") return p;
    const { ok, reason } = osSandbox();
    if (!ok && mode === "required") p.problems.push(`config.sandbox.os is "required" but no OS sandbox is usable here (${reason}).`);
    else if (!ok) ctx.bus.emit("ui:info", { message: `no OS sandbox (${reason}); running with the guard only.` });
    return p;
  });

  ctx.bus.onPipe("run:wrap", (p) => {
    if (mode === "off" || isolated) return p;
    const b = osSandbox();
    if (!b.ok) return p;
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
