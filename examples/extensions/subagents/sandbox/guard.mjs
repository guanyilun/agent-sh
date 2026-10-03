// A tripwire for headless runs, not isolation (SANDBOX.md).
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { writeRoots, hidden, policyFile } from "./env.mjs";

const expand = (p) => path.resolve(String(p).replace(/^~(?=\/|$)/, os.homedir()));
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

const RECURSIVE = /(^|[\s;&|(`])(find|rg|fd|du|tree|locate|grep\s+-\w*[rR]\w*|grep\s+--recursive|ls\s+-\w*R\w*)\b/;
const GIT = /\bgit\s+(push|commit|reset|rebase|checkout\s+--|clean|stash|branch\s+-[dD]|tag)\b/;
const RMRF = /\brm\s+-\w*[rR]\w*\s+(\S+)/g;
const EVERYTHING = /[\s\S]/;

const underAny = (p, list) => { const r = expand(p); return list.some(root => r === root || r.startsWith(root + path.sep)); };
const refuse = (msg) => ({ content: `Blocked by sandbox guard: ${msg}`, exitCode: 1, isError: true });

// An unreadable policy refuses everything: failing open would silently drop its rules.
function loadRules(files) {
  const forbid = [], searchAt = [], searchUnder = [];
  let searchMessage = "recursive searches of shared filesystems are forbidden; pass a narrower path.";
  for (const { file, label } of files) {
    try {
      const r = JSON.parse(fs.readFileSync(file, "utf8"));
      for (const f of r.forbid || []) forbid.push({ re: new RegExp(f.regex), message: f.message || `matches forbidden pattern ${f.regex}` });
      if (r.noRecursiveSearch) {
        searchAt.push(...(r.noRecursiveSearch.at || []));
        searchUnder.push(...(r.noRecursiveSearch.under || []));
        if (r.noRecursiveSearch.message) searchMessage = r.noRecursiveSearch.message;
      }
    } catch (e) {
      forbid.push({ re: EVERYTHING, message: `${label} could not be read (${e.message}); refusing everything`, all: true });
    }
  }
  const atRe = searchAt.length ? new RegExp(`(\\s|=)(${searchAt.map(escape).join("|")})\\/?(\\s|$|;|&|\\||\\))`) : null;
  const underRe = searchUnder.length ? new RegExp(`(${searchUnder.map(escape).join("|")})\\b`) : null;
  return { forbid, searchAt, atRe, underRe, searchMessage };
}

export function makeVerdict({ write = [], hide = [], policy = [] } = {}) {
  const ROOTS = write.map(expand);
  const HIDDEN = hide.map(expand);
  const files = [policy].flat().filter(Boolean).map(file => ({ file, label: `sandbox policy ${file}` }));
  const rules = loadRules(files);
  const isHidden = (p) => HIDDEN.length > 0 && underAny(p, HIDDEN);
  const mentionsHidden = (s) => HIDDEN.some(h => s.includes(h) || s.includes(path.basename(h)) && path.basename(h).length > 6);

  return function verdict(name, a) {
    a = a || {};
    for (const r of rules.forbid) if (r.all) return refuse(r.message);
    if (name === "bash" || name === "pwsh") {
      const c = String(a.command || "");
      if (RECURSIVE.test(c) && (rules.atRe?.test(c + " ") || rules.underRe?.test(c))) return refuse(rules.searchMessage);
      if (GIT.test(c)) return refuse("git commands that change history or branches are reserved for the user.");
      for (const m of c.matchAll(RMRF)) if (!underAny(m[1], ROOTS)) return refuse(`rm -r outside the allowed write roots (${m[1]}).`);
      if (mentionsHidden(c)) return refuse("that path is hidden from agents (held-out data).");
      for (const r of rules.forbid) if (r.re.test(c)) return refuse(r.message);
    }
    if (name === "write_file" || name === "edit_file") {
      if (!underAny(String(a.path || ""), ROOTS))
        return refuse(`writes are limited to ${ROOTS.join(":") || "(no writable dirs)"}; got ${a.path}. If blocked, put the content in your final answer.`);
    }
    if (name === "read_file" || name === "ls" || name === "glob" || name === "grep") {
      const p = a.path ?? (name === "read_file" || name === "ls" ? "" : ".");
      if (isHidden(String(p || ".")) || mentionsHidden(String(a.pattern || ""))) return refuse("that path is hidden from agents (held-out data).");
      if ((name === "glob" || name === "grep") && rules.searchAt.includes(expand(p || ".").replace(/\/$/, "")))
        return refuse(rules.searchMessage);
    }
    return null;
  };
}

export const verdict = makeVerdict({ write: writeRoots(), hide: hidden(), policy: policyFile() });

const TOOLS = ["bash", "pwsh", "write_file", "edit_file", "read_file", "ls", "glob", "grep"];
export default function activate(ctx, check = verdict) {
  ctx.advise("tool:execute", async (next, t) => check(t.name, t.args) || next(t));
  // subagents call tools through tool:<name>, bypassing tool:execute
  for (const name of TOOLS)
    ctx.advise(`tool:${name}`, async (next, args, ...rest) => check(name, args) || next(args, ...rest));
}
