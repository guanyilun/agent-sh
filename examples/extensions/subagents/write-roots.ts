// Per-agent write roots: a tripwire on one subagent's writes, narrower than the run's sandbox.
// Like the sandbox guard, it catches honest mistakes (a critic saving scratch files into the code it reviews, a
// builder editing the wrong tree), not a determined escape: the OS sandbox stays the boundary.
import * as os from "node:os";
import * as path from "node:path";

export interface WriteRefusal { content: string; exitCode: number; isError: true }

const expand = (p: string, cwd: string) => path.resolve(cwd, String(p).replace(/^~(?=\/|$)/, os.homedir()));
const under = (p: string, roots: string[]) => roots.some(r => p === r || p.startsWith(r + path.sep));
const DEVICES = new Set(["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty"]);

/** The paths a shell command visibly writes, resolved against `cwd` (following `cd DIR` between commands):
 * redirections, tee, and the targets of rm/mv/cp/mkdir/touch/sed -i. */
export function writtenPaths(command: string, cwd: string): string[] {
  const out: string[] = [];
  let here = cwd;
  const clean = (w: string) => w.replace(/^['"]|['"]$/g, "");
  // Code passed to interpreters is not shell: drop heredoc bodies and quoted strings ("a > b" in python -c '...').
  const shell = command
    .replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2\s*(?=\n|$)/g, " ")
    .replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, (q) => (/^['"][\w./~-]+['"]$/.test(q) ? q : " Q "));
  for (const segment of shell.split(/&&|\|\||[;|\n]/)) {
    const s = segment.trim();
    for (const m of s.matchAll(/(?:^|[^<>&\d])\d?>>?\s*([^\s;&|()<>]+)/g)) if (!m[1]!.startsWith("&")) out.push(expand(clean(m[1]!), here));
    const words = s.replace(/\d?>>?\s*[^\s;&|()<>]+/g, " ").split(/\s+/).filter(Boolean).map(clean);
    const lead = words[0] === "sudo" ? 1 : 0;
    const cmd = words[lead];
    const args = words.slice(lead + 1).filter(w => !w.startsWith("-"));
    if (cmd === "cd" && args[0] && !args[0].includes("$")) { here = expand(args[0], here); continue; }
    let targets: string[] = [];
    if (cmd === "tee" || cmd === "rm" || cmd === "mkdir" || cmd === "touch" || cmd === "rmdir") targets = args;
    else if ((cmd === "mv" || cmd === "cp" || cmd === "install" || cmd === "ln") && args.length >= 2) targets = [args[args.length - 1]!];
    else if (cmd === "sed" && words.some(w => /^-\w*i/.test(w)) && args.length >= 2) targets = args.slice(1);
    out.push(...targets.filter(w => !w.includes("$")).map(w => expand(w, here)));
  }
  return out.filter(p => !p.includes("$") && !/\/\d+$/.test(p));
}

/** A check for one agent's tool calls: null when allowed, a refusal otherwise.  `roots` [] makes the agent read-only. */
export function writeRootsVerdict(roots: string[], cwd: string) {
  const allowed = roots.map(r => expand(r, cwd));
  const where = allowed.length ? `under ${allowed.join(", ")}` : "nowhere (this agent is read-only)";
  const refuse = (what: string): WriteRefusal => ({
    content: `Blocked: this agent may write only ${where}; ${what}.  Put the content in your answer, or write scratch files under an allowed path.`,
    exitCode: 1, isError: true,
  });
  return (tool: string, args: Record<string, unknown> = {}): WriteRefusal | null => {
    if (tool === "write_file" || tool === "edit_file") {
      const p = expand(String(args.path ?? args.file_path ?? ""), cwd);
      return under(p, allowed) ? null : refuse(`got ${p}`);
    }
    if (tool === "bash" || tool === "pwsh") {
      for (const p of writtenPaths(String(args.command ?? ""), cwd)) {
        if (!DEVICES.has(p) && !under(p, allowed)) return refuse(`the command writes ${p}`);
      }
    }
    return null;
  };
}
