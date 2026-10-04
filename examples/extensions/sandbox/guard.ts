// A tripwire against honest mistakes, not isolation (README.md).
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface GuardPolicy {
  write?: string[];
  hide?: string[];
  /** JSON files with extra rules. */
  policy?: string | string[];
}

export interface Refusal { content: string; exitCode: number; isError: true }
export type Verdict = (tool: string, args?: Record<string, unknown>) => Refusal | null;

interface Rules {
  forbid: { re: RegExp; message: string; all?: boolean }[];
  searchAt: string[];
  atRe: RegExp | null;
  underRe: RegExp | null;
  searchMessage: string;
}

const expand = (p: string) => path.resolve(String(p).replace(/^~(?=\/|$)/, os.homedir()));
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

const RECURSIVE = /(^|[\s;&|(`])(find|rg|fd|du|tree|locate|grep\s+-\w*[rR]\w*|grep\s+--recursive|ls\s+-\w*R\w*)\b/;
const RMRF = /\brm\s+-\w*[rR]\w*\s+(\S+)/g;
const EVERYTHING = /[\s\S]/;

const underAny = (p: string, list: string[]) => { const r = expand(p); return list.some(root => r === root || r.startsWith(root + path.sep)); };
const refuse = (msg: string): Refusal => ({ content: `Blocked by sandbox guard: ${msg}`, exitCode: 1, isError: true });

// An unreadable policy refuses everything: failing open would silently drop its rules.
function loadRules(files: string[]): Rules {
  const forbid: Rules["forbid"] = [];
  const searchAt: string[] = [], searchUnder: string[] = [];
  let searchMessage = "recursive searches there are forbidden; pass a narrower path.";
  for (const file of files) {
    try {
      const r = JSON.parse(fs.readFileSync(file, "utf8"));
      for (const f of r.forbid || []) forbid.push({ re: new RegExp(f.regex), message: f.message || `matches forbidden pattern ${f.regex}` });
      if (r.noRecursiveSearch) {
        searchAt.push(...(r.noRecursiveSearch.at || []));
        searchUnder.push(...(r.noRecursiveSearch.under || []));
        if (r.noRecursiveSearch.message) searchMessage = r.noRecursiveSearch.message;
      }
    } catch (e) {
      forbid.push({ re: EVERYTHING, message: `sandbox policy ${file} could not be read (${(e as Error).message}); refusing everything`, all: true });
    }
  }
  const atRe = searchAt.length ? new RegExp(`(\\s|=)(${searchAt.map(escape).join("|")})\\/?(\\s|$|;|&|\\||\\))`) : null;
  const underRe = searchUnder.length ? new RegExp(`(${searchUnder.map(escape).join("|")})\\b`) : null;
  return { forbid, searchAt, atRe, underRe, searchMessage };
}

export function makeVerdict({ write = [], hide = [], policy = [] }: GuardPolicy = {}): Verdict {
  const roots = write.map(expand);
  const hidden = hide.map(expand);
  const rules = loadRules([policy].flat().filter(Boolean));
  const isHidden = (p: string) => hidden.length > 0 && underAny(p, hidden);
  // Only words that look like paths: naming a hidden dir isn't reading it.
  const reachesHidden = (command: string) => hidden.some(h => command.includes(h))
    || command.split(/[\s;|&()<>"'`=]+/).some(word => /^~|\//.test(word) && isHidden(word));

  return function verdict(name, a = {}) {
    for (const r of rules.forbid) if (r.all) return refuse(r.message);
    if (name === "bash" || name === "pwsh") {
      const c = String(a.command || "");
      if (RECURSIVE.test(c) && (rules.atRe?.test(c + " ") || rules.underRe?.test(c))) return refuse(rules.searchMessage);
      for (const m of c.matchAll(RMRF)) if (!underAny(m[1]!, roots)) return refuse(`rm -r outside the allowed write roots (${m[1]}).`);
      if (reachesHidden(c)) return refuse("that path is hidden from agents.");
      for (const r of rules.forbid) if (r.re.test(c)) return refuse(r.message);
    }
    if (name === "write_file" || name === "edit_file") {
      if (!underAny(String(a.path || ""), roots))
        return refuse(`writes are limited to ${roots.join(":") || "(no writable dirs)"}; got ${a.path}. If blocked, put the content in your final answer.`);
    }
    if (name === "read_file" || name === "ls" || name === "glob" || name === "grep") {
      const p = String(a.path ?? (name === "read_file" || name === "ls" ? "" : ".")) || ".";
      if (isHidden(p) || hidden.some(h => String(a.pattern || "").includes(h))) return refuse("that path is hidden from agents.");
      if ((name === "glob" || name === "grep") && rules.searchAt.includes(expand(p).replace(/\/$/, "")))
        return refuse(rules.searchMessage);
    }
    return null;
  };
}

const TOOLS = ["bash", "pwsh", "write_file", "edit_file", "read_file", "ls", "glob", "grep"];

type Advise = (name: string, wrapper: (next: (...args: any[]) => any, ...args: any[]) => any) => unknown;

export function armGuard(ctx: { advise: Advise }, check: Verdict): void {
  ctx.advise("tool:execute", async (next, t) => check(t.name, t.args) || next(t));
  // Subagents call tools through tool:<name>, bypassing tool:execute.
  for (const name of TOOLS)
    ctx.advise(`tool:${name}`, async (next, args, ...rest) => check(name, args) || next(args, ...rest));
}
