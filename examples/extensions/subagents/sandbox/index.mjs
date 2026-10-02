/**
 * Sandboxing for the subagents extension. Inert unless armed, so interactive sessions are unaffected. Two ways to arm it:
 *
 * 1. `agent-sh run <file>` whose `export const config` has a `sandbox` section (see SANDBOX.md):
 *      sandbox: { write: [...], hide: [...], policy: "rules.json", os: "preferred" }
 *    plus `hours` for the clock. Paths are relative to the file. Where an OS sandbox works (bubblewrap, else Landlock,
 *    on Linux; Seatbelt on macOS), the whole run is re-executed inside it; `os: "required"` refuses to start without
 *    one. Elsewhere (e.g. Windows) the guard alone applies.
 * 2. SBX_* variables, for callers that start agent-sh themselves: SBX_GUARD=1, SBX_WRITE_ROOTS=a:b, SBX_HIDE=a:b,
 *    SBX_POLICY=file.json, SBX_DEADLINE=<unix> (SBX_BUDGET_MIN). Wrap the process in sandbox.sh yourself for isolation.
 * When armed it emits "sandbox guard armed (...)"; headless callers should require that notice.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import guard, { makeVerdict } from "./guard.mjs";
import clock from "./clock.mjs";
import { armed, writeRoots, hidden, policyFile, home } from "./env.mjs";
import { probeSeatbelt, seatbeltArgv } from "./seatbelt.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export default function activate(ctx) {
  const run = ctx.list?.().includes("run:config") ? ctx.call("run:config") : undefined;
  if (run?.sandbox) return activateForRun(ctx, run);

  if (armed) {
    guard(ctx);
    const msg = `sandbox guard armed (write roots: ${writeRoots().join(":") || "none"}; hidden: ${hidden().length}; policy: ${policyFile() || "none"})`;
    ctx.bus?.emit?.("ui:info", { message: msg });
  }
  clock(ctx);   // no-op unless a deadline is set
  if (run?.hours) runClock(ctx, run);
}

/** Whether bubblewrap actually works here: some systems install it but block unprivileged user namespaces. */
export function probeBwrap(bwrap) {
  if (!fs.existsSync(bwrap)) return { ok: false, reason: `${bwrap} not found` };
  const r = spawnSync(bwrap, ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--unshare-pid", "true"], { encoding: "utf8", timeout: 10_000 });
  if (r.status === 0) return { ok: true };
  return { ok: false, reason: `${bwrap} failed: ${(r.stderr || r.error?.message || `exit ${r.status}`).trim().split("\n")[0]}` };
}

/** Whether Landlock works here, through landlock.py (Linux 5.13+ with Landlock enabled, and python3). */
export function probeLandlock(python) {
  if (process.env.SBX_LANDLOCK === "off") return { ok: false, reason: "disabled (SBX_LANDLOCK=off)" };
  const r = spawnSync(python, [path.join(HERE, "landlock.py"), "--probe"], { encoding: "utf8", timeout: 10_000 });
  if (r.status === 0) return { ok: true };
  if (r.error) return { ok: false, reason: `${python} not usable (${r.error.message})` };
  return { ok: false, reason: (r.stderr || `exit ${r.status}`).trim().split("\n").pop().replace(/^landlock: /, "") };
}

function activateForRun(ctx, run) {
  const sb = run.sandbox;
  const abs = (p) => path.resolve(run.base, p);
  const write = (sb.write ?? []).map(abs);
  const hide = (sb.hide ?? []).map(abs);
  const policy = sb.policy ? abs(sb.policy) : "";
  const os = sb.os ?? "preferred";
  const isolated = process.env.SBX_SANDBOXED === "1";
  let backend;
  const osSandbox = () => (backend ??= pickBackend());

  guard(ctx, makeVerdict({ write, hide, policy }));
  const kind = isolated ? `on (${process.env.SBX_SANDBOX_KIND || "bubblewrap"})` : "off";
  ctx.bus.emit("ui:info", { message: `sandbox guard armed (write roots: ${write.join(":") || "none"}; hidden: ${hide.length}; policy: ${policy || "none"}; os sandbox: ${kind})` });
  runClock(ctx, run);

  ctx.bus.onPipe("run:checks", (p) => {
    p.handled.push("sandbox");
    // The whole run is one process that must reach the model, so cutting its network can't work yet.
    if (sb.net === false) p.problems.push("config.sandbox.net: false isn't supported yet: the run itself needs the network to reach the model. Cutting the network for agents' commands needs per-agent isolation.");
    if (isolated || os === "off") return p;
    const { ok, reason } = osSandbox();
    if (!ok && os === "required") p.problems.push(`config.sandbox.os is "required" but no OS sandbox is usable here (${reason}).`);
    else if (!ok) ctx.bus.emit("ui:info", { message: `no OS sandbox (${reason}); running with the guard only.` });
    return p;
  });
  ctx.bus.onPipe("run:wrap", (p) => {
    if (os === "off" || isolated) return p;
    const b = osSandbox();
    if (!b.ok) return p;
    if (b.kind === "seatbelt") return { ...p, argv: seatbeltArgv(b.path, { write, hide, home }, p.argv) };
    if (b.kind === "landlock") {
      const args = [b.path, path.join(HERE, "landlock.py"), "--home", home];
      for (const w of write) args.push("--rw", w);
      for (const h of hide) args.push("--hide", h);
      return { ...p, argv: [...args, "--", ...p.argv] };
    }
    const args = [path.join(HERE, "sandbox.sh"), "--home", home];
    for (const w of write) args.push("--rw", w);
    for (const h of hide) args.push("--hide", h);
    return { ...p, argv: [...args, "--", ...p.argv] };
  });
}

// On Linux bubblewrap, else Landlock; Seatbelt on macOS. Each only if it actually runs here.
function pickBackend() {
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

function runClock(ctx, run) {
  const hours = Number(run.hours);
  if (hours > 0) clock(ctx, { deadline: Date.now() / 1000 + hours * 3600, budget: hours * 60 });
}
