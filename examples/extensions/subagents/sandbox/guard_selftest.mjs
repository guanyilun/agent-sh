// Self-test of guard.mjs, no LLM: SBX_WRITE_ROOTS=/some/dir [SBX_HIDE=/secret/dir] node guard_selftest.mjs
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import activate, { makeVerdict } from "./guard.mjs";
import { writeRoots, hidden } from "./env.mjs";

const root = writeRoots()[0];
if (!root) { console.error("set SBX_WRITE_ROOTS"); process.exit(1); }
const hide = hidden()[0];
const policy = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sbx-policy-")), "policy.json");
fs.writeFileSync(policy, JSON.stringify({
  forbid: [{ regex: "(^|\\s)curl\\s", message: "no network downloads" }],
  noRecursiveSearch: { at: ["/srv/shared"], under: ["/opt/big"], message: "too big to search" },
}));

const handlers = {};
activate({ advise: (name, fn) => { (handlers[name] ||= []).push(fn); } }, makeVerdict({ write: writeRoots(), hide: hidden(), policy }));
const passed = { content: "PASSED", exitCode: 0 };
const cases = [
  ["bash", { command: "git push origin main" }, false],
  ["bash", { command: "rm -rf /elsewhere/dir" }, false],
  ["write_file", { path: "/elsewhere/x.txt", content: "x" }, false],
  ["edit_file", { path: "/etc/passwd" }, false],
  ["bash", { command: "curl https://example.com/x" }, false],
  ["bash", { command: "find /srv/shared -name x" }, false],
  ["bash", { command: "grep -r foo /opt/big/lib" }, false],
  ["glob", { pattern: "**/*.py", path: "/srv/shared" }, false],
  ["bash", { command: "python evaluate.py design.json" }, true],
  ["bash", { command: "find . -name '*.py'" }, true],
  ["write_file", { path: `${root}/ok.txt`, content: "x" }, true],
  ["read_file", { path: `${root}/ok.txt` }, true],
  ["glob", { pattern: "*.json", path: root }, true],
];
if (hide) cases.push(
  ["read_file", { path: `${hide}/secret.json` }, false],
  ["ls", { path: hide }, false],
  ["bash", { command: `cat ${hide}/secret.json` }, false],
  ["grep", { pattern: "x", path: hide }, false]);
let bad = 0;
for (const [name, args, allow] of cases) {
  for (const hook of ["tool:execute", `tool:${name}`]) {
    const fns = handlers[hook];
    if (!fns) { console.error(`missing hook ${hook}`); bad++; continue; }
    const fn = fns[fns.length - 1];
    const r = hook === "tool:execute" ? await fn(async () => passed, { name, args }) : await fn(async () => passed, args);
    const ok = allow ? r === passed : (r && r.isError && /Blocked by sandbox guard/.test(r.content));
    if (!ok) { console.error(`FAIL ${hook} ${JSON.stringify(args)} -> ${JSON.stringify(r)}`); bad++; }
  }
}
fs.rmSync(path.dirname(policy), { recursive: true, force: true });
if (bad) { console.error(`guard selftest: ${bad} failures`); process.exit(1); }
console.log(`guard selftest ok (${cases.length} cases x 2 hooks${hide ? ", hidden paths included" : ""})`);
