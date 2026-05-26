// LIPS Scheme as a cognitive substrate: one tool (scheme_eval) + host
// bridges that route through whatever bash/read_file/write_file the agent
// has registered. Single-file so reload_extensions picks up edits cleanly
// without the static-import-cache hazard a multi-file layout introduces.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentContext } from "agent-sh/types";
import { getSettings } from "agent-sh/settings";
import lips from "@jcubic/lips";

type ToolResult = {
  content: string; exitCode: number | null; isError: boolean;
  display?: any;
};
type ToolExecutor = (args: Record<string, unknown>) => Promise<ToolResult>;
type Bus = { emit: (event: string, payload: any) => void };

let callCounter = 0;
async function withDisplay(
  bus: Bus, toolName: string, kind: string, rawInput: any, displayDetail: string,
  run: () => Promise<ToolResult>,
): Promise<ToolResult> {
  const toolCallId = `scheme-${toolName}-${++callCounter}`;
  bus.emit("agent:tool-started", {
    title: toolName, toolCallId, kind, rawInput, displayDetail,
  });
  const result = await run();
  bus.emit("agent:tool-completed", {
    toolCallId,
    exitCode: result.exitCode,
    rawOutput: result.content,
    kind,
    resultDisplay: result.display,
  });
  return result;
}

// schemeOnly: capture executors up front, then unregister kernel built-ins so
// scheme_eval is the only tool. The bridge re-emits tool lifecycle events so
// the TUI still renders diffs.
const HIDDEN_IN_SCHEME_ONLY = ["bash", "pwsh", "read_file", "write_file", "edit_file", "ls", "glob", "grep"];

const { Pair, nil, LSymbol, LNumber, Macro, evaluate: lipsEvaluate } = lips as any;

// LIPS' `define` discards the promise returned by async host bindings.
// With `(define x (read-file …)) x` the exec() advances before `env.set`
// fires, so `x` is reported unbound. Reinstall to return the promise.
function installFixedDefine(env: any): void {
  const fixed = Macro.defmacro("define", function (this: any, code: any, eval_args: any) {
    const target = this;
    if (code.car instanceof Pair && code.car.car instanceof LSymbol) {
      return new Pair(
        new LSymbol("define"),
        new Pair(
          code.car.car,
          new Pair(
            new Pair(new LSymbol("lambda"), new Pair(code.car.cdr, code.cdr)),
            nil,
          ),
        ),
      );
    } else if (eval_args.macro_expand) {
      return;
    }
    if (eval_args.dynamic_scope) eval_args.dynamic_scope = target;
    eval_args.env = target;
    let value = code.cdr.car;
    if (value instanceof Pair) {
      value = lipsEvaluate(value, eval_args);
    } else if (value instanceof LSymbol) {
      value = target.get(value);
    }
    if (code.car instanceof LSymbol) {
      const name = code.car;
      if (value && typeof value.then === "function") {
        return value.then((v: any) => { target.set(name, v); });
      }
      target.set(name, value);
    }
  });
  env.set("define", fixed);
}

// LIPS' `if` is strict-boolean: `(if "hello" …)` errors. R7RS, Racket, Chicken
// — essentially every Scheme model is trained on — treat any non-#f as true.
// Reinstall a lenient `if`.
function installLenientIf(env: any): void {
  const lenient = new Macro("if", function (this: any, code: any, opts: any) {
    const target = this;
    const dynScope = opts.dynamic_scope ? target : undefined;
    const choose = (cond: any) => {
      const branch = cond !== false ? code.cdr.car : code.cdr.cdr.car;
      return lipsEvaluate(branch, { env: target, dynamic_scope: dynScope, error: opts.error });
    };
    const condVal = lipsEvaluate(code.car, { env: target, dynamic_scope: dynScope, error: opts.error });
    if (condVal && typeof condVal.then === "function") return condVal.then(choose);
    return choose(condVal);
  });
  env.set("if", lenient);
}

const LOG_PATH = path.join(os.homedir(), ".agent-sh", "scheme-eval.log");
const SCHEME_DEFINE_DIR = path.join(os.homedir(), ".agent-sh", "scheme-define");
const MAX_OUTPUT_LEN = 128 * 1024;

type DefineEntry = { args: string; doc: string };
type DefineRegistry = Map<string, DefineEntry>;

function sanitizeDefineName(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, (c) => "_" + c.charCodeAt(0).toString(16));
}

function installSchemeDefine(
  env: any,
  registry: DefineRegistry,
  loading: { active: boolean },
  onRegister: () => void,
): void {
  const mac = Macro.defmacro("scheme-define", function (this: any, code: any, eval_args: any) {
    if (eval_args.macro_expand) return;
    if (!(code instanceof Pair) || !(code.car instanceof LSymbol)) {
      throw new Error("scheme-define: expected (scheme-define name (args …) \"doc\" body …)");
    }
    const nameSym = code.car;
    const name = nameSym.name;
    const argsForm = code.cdr instanceof Pair ? code.cdr.car : nil;
    let rest = code.cdr instanceof Pair ? code.cdr.cdr : nil;
    let doc = "";
    if (rest instanceof Pair && typeof rest.car === "string") {
      doc = rest.car;
      rest = rest.cdr;
    }
    if (!(rest instanceof Pair)) {
      throw new Error(`scheme-define ${name}: missing body`);
    }

    const argsStr = argsForm === nil ? "()" : (argsForm as any).toString();
    registry.set(name, { args: argsStr, doc });
    onRegister();

    if (!loading.active) {
      try {
        fs.mkdirSync(SCHEME_DEFINE_DIR, { recursive: true });
        const fullForm = new Pair(new LSymbol("scheme-define"), code);
        const text = (fullForm as any).toString();
        fs.writeFileSync(path.join(SCHEME_DEFINE_DIR, sanitizeDefineName(name) + ".scm"), text + "\n");
      } catch (e) {
        logErr("scheme-define write", e, { name });
      }
    }

    return new Pair(
      new LSymbol("define"),
      new Pair(new Pair(nameSym, argsForm), rest),
    );
  });
  env.set("scheme-define", mac);
}

async function loadPersistedDefines(
  env: any,
  registry: DefineRegistry,
  loading: { active: boolean },
): Promise<void> {
  let files: string[] = [];
  try {
    files = fs.readdirSync(SCHEME_DEFINE_DIR).filter((f) => f.endsWith(".scm"));
  } catch {
    return;
  }
  loading.active = true;
  try {
    for (const f of files) {
      const fp = path.join(SCHEME_DEFINE_DIR, f);
      try {
        const src = fs.readFileSync(fp, "utf-8");
        await (lips as any).exec(src, env);
      } catch (e) {
        logErr("scheme-define load", e, { file: fp });
      }
    }
  } finally {
    loading.active = false;
  }
}

function formatDefineIndex(registry: DefineRegistry): string {
  if (registry.size === 0) return "";
  const rows = [...registry.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, { args, doc }]) => `  ${name} ${args}${doc ? "  — " + doc : ""}`);
  return rows.join("\n");
}

function summarizeResult(content: string, isError: boolean): string {
  if (isError) return "error";
  const c = content;
  if (c === "") return "ok";
  if (c === "true" || c === "false") return c;
  if (/^-?\d+(\.\d+)?$/.test(c)) return c;
  if (c.startsWith('"') && c.endsWith('"')) {
    // Count newlines in string literal content. `format()` JSON-stringifies,
    // so newlines appear as the 2-char escape `\n`.
    const inner = c.slice(1, -1);
    let nl = 0;
    for (let i = 0; i < inner.length - 1; i++) {
      if (inner[i] === "\\" && inner[i + 1] === "n") { nl++; i++; }
    }
    const lines = inner.length === 0 ? 0 : nl + 1;
    return `${lines} line${lines === 1 ? "" : "s"}`;
  }
  if (c.startsWith("(") && c.endsWith(")")) {
    // Count items in a top-level list, handling nested parens and strings.
    let depth = 0, count = 0, inStr = false, esc = false, inAtom = false;
    for (let i = 1; i < c.length - 1; i++) {
      const ch = c[i];
      if (esc) { esc = false; continue; }
      if (inStr) {
        if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') {
        if (depth === 0 && !inAtom) { count++; inAtom = true; }
        inStr = true;
      } else if (ch === "(") {
        if (depth === 0) count++;
        depth++;
        inAtom = false;
      } else if (ch === ")") {
        depth--;
        inAtom = false;
      } else if (depth === 0) {
        if (/\s/.test(ch)) inAtom = false;
        else if (!inAtom) { count++; inAtom = true; }
      }
    }
    return `${count} item${count === 1 ? "" : "s"}`;
  }
  return c.length > 40 ? `${c.slice(0, 37)}…` : c;
}

// ── diagnostic log ────────────────────────────────────────────────
function logErr(where: string, err: any, extras?: Record<string, unknown>): void {
  try {
    const stamp = new Date().toISOString();
    const stack = err?.stack || `${err?.message ?? String(err)} (no stack)`;
    const code = Array.isArray(err?.code) ? "\n  scheme-frames:\n    " + err.code.join("\n    ") : "";
    const extra = extras ? "\nextras: " + JSON.stringify(extras, null, 2) : "";
    fs.appendFileSync(LOG_PATH, `\n=== ${stamp} ${where} ===\n${stack}${code}${extra}\n`);
  } catch {}
}

// ── LIPS value helpers ────────────────────────────────────────────
function alist(entries: Array<[string, unknown]>): unknown {
  let tail: any = nil;
  for (let i = entries.length - 1; i >= 0; i--) {
    const [k, v] = entries[i];
    tail = new Pair(new Pair(new LSymbol(k), v), tail);
  }
  return tail;
}

function lookup(result: unknown, key: string): unknown {
  let node: any = result;
  while (node && node instanceof Pair) {
    const entry = node.car;
    if (entry && entry.car && entry.car.name === key) return entry.cdr;
    node = node.cdr;
  }
  return undefined;
}

function toSchemeList(items: unknown[]): unknown {
  let tail: any = nil;
  for (let i = items.length - 1; i >= 0; i--) tail = new Pair(items[i], tail);
  return tail;
}

// Parse ripgrep content-mode lines: "file:line:text" or (for single-file
// invocations) "line:text". When ripgrep omits the filename prefix, the
// caller passes the single-file path explicitly via fallbackFile.
function parseGrepLine(line: string, fallbackFile?: string): unknown | null {
  const i1 = line.indexOf(":");
  if (i1 < 0) return null;
  const head = line.slice(0, i1);
  const headNum = parseInt(head, 10);
  if (fallbackFile && !Number.isNaN(headNum) && String(headNum) === head) {
    return alist([
      ["file", fallbackFile],
      ["line", headNum],
      ["text", line.slice(i1 + 1)],
    ]);
  }
  const i2 = line.indexOf(":", i1 + 1);
  if (i2 < 0) return null;
  const lineNum = parseInt(line.slice(i1 + 1, i2), 10);
  if (Number.isNaN(lineNum)) return null;
  return alist([
    ["file", head],
    ["line", lineNum],
    ["text", line.slice(i2 + 1)],
  ]);
}

function stripPagination(raw: string): string[] {
  return raw.split("\n").filter((l) => l && !l.startsWith("[Showing "));
}

function format(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v && typeof (v as any).toString === "function") {
    try { return (v as any).toString(); } catch {}
  }
  return String(v);
}

// ── evaluator ─────────────────────────────────────────────────────
// LIPS implements string literals via JSON.parse, which rejects backslash
// escapes outside JSON's tiny set (\" \\ \/ \b \f \n \r \t \uXXXX). Models
// routinely write \s \w \d etc. in regex strings. Pre-process: promote any
// invalid \X to \\X so LIPS parses it as a literal backslash + X.
function preprocessSchemeSource(source: string): string {
  const JSON_ESC = new Set(["\\", "/", '"', "b", "f", "n", "r", "t"]);
  let out = "";
  let inStr = false;
  let inComment = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === "\n") {
      out += c;
      inComment = false;
      continue;
    }
    if (inComment) { out += c; continue; }
    if (!inStr) {
      if (c === ";") { inComment = true; out += c; continue; }
      if (c === '"') { inStr = true; out += c; continue; }
      out += c;
      continue;
    }
    if (c === '"') { inStr = false; out += c; continue; }
    if (c !== "\\") { out += c; continue; }
    const next = source[i + 1];
    if (next === undefined) { out += c; continue; }
    if (JSON_ESC.has(next)) { out += c + next; i++; continue; }
    if (next === "u") {
      const hex = source.slice(i + 2, i + 6);
      if (/^[0-9a-fA-F]{4}$/.test(hex)) { out += "\\u" + hex; i += 5; continue; }
      // malformed \uXXXX — promote to literal
      out += "\\\\u";
      i++;
      continue;
    }
    // Any other \X — promote so JSON.parse sees \\X → literal
    out += "\\\\" + next;
    i++;
  }
  return out;
}

// If LIPS reports a JSON-parse failure, localize the invalid escapes so the
// agent gets actionable line/col info instead of a raw offset. Only triggers
// when preprocessing didn't catch everything.
function formatStringEscapeDiagnostic(source: string, baseMsg: string): string {
  const JSON_ESC = new Set(["\\", "/", '"', "b", "f", "n", "r", "t"]);
  let line = 1, col = 1;
  let inStr = false, inComment = false;
  const bad: { line: number; col: number; seq: string }[] = [];
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === "\n") { line++; col = 1; inComment = false; continue; }
    if (inComment) { col++; continue; }
    if (!inStr) {
      if (c === ";") { inComment = true; col++; continue; }
      if (c === '"') { inStr = true; col++; continue; }
      col++;
      continue;
    }
    if (c === '"') { inStr = false; col++; continue; }
    if (c === "\\") {
      const next = source[i + 1];
      if (next === undefined) { col++; continue; }
      let valid = JSON_ESC.has(next);
      if (next === "u") {
        valid = /^[0-9a-fA-F]{4}$/.test(source.slice(i + 2, i + 6));
      }
      if (!valid) bad.push({ line, col, seq: "\\" + next });
      i++; col += 2;
      continue;
    }
    col++;
  }
  if (bad.length === 0) return baseMsg;
  const MAX = 5;
  const shown = bad.slice(0, MAX)
    .map((b) => `line ${b.line} col ${b.col} (${b.seq})`).join(", ");
  const extra = bad.length > MAX ? ` (… ${bad.length - MAX} more)` : "";
  return baseMsg +
    `\n  ${bad.length} invalid string escape(s): ${shown}${extra}` +
    `\n  LIPS strings use JSON escapes: \\\\ \\" \\n \\r \\t \\b \\f \\uXXXX.` +
    ` For a literal backslash write \\\\.`;
}

// Scan for unmatched parens with line/col + leader symbol, so parse failures
// give actionable feedback instead of bare "Unbalanced parenthesis".
function analyzeParens(source: string): {
  unmatchedOpens: { line: number; col: number; lead: string }[];
  unmatchedCloses: { line: number; col: number }[];
} {
  const stack: { line: number; col: number; lead: string }[] = [];
  const unmatchedCloses: { line: number; col: number }[] = [];
  let line = 1, col = 1;
  let inStr = false, esc = false, inComment = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === "\n") { line++; col = 1; inComment = false; continue; }
    if (inComment) { col++; continue; }
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      col++; continue;
    }
    if (c === ";") { inComment = true; col++; continue; }
    if (c === '"') { inStr = true; col++; continue; }
    if (c === "(") {
      let j = i + 1;
      while (j < source.length && /\s/.test(source[j])) j++;
      let k = j;
      while (k < source.length && !/[\s()";]/.test(source[k])) k++;
      stack.push({ line, col, lead: source.slice(j, k) });
      col++; continue;
    }
    if (c === ")") {
      if (stack.length === 0) unmatchedCloses.push({ line, col });
      else stack.pop();
      col++; continue;
    }
    col++;
  }
  return { unmatchedOpens: stack, unmatchedCloses };
}

function formatParenDiagnostic(source: string, baseMsg: string): string {
  const a = analyzeParens(source);
  const parts: string[] = [baseMsg];
  const MAX = 5;
  if (a.unmatchedOpens.length > 0) {
    const shown = a.unmatchedOpens.slice(-MAX).map(
      (o) => `line ${o.line} col ${o.col} (${o.lead || "?"})`
    ).join(", ");
    const extra = a.unmatchedOpens.length > MAX
      ? ` (… ${a.unmatchedOpens.length - MAX} more)` : "";
    parts.push(`  ${a.unmatchedOpens.length} unmatched '(' — opened at ${shown}${extra}`);
  }
  if (a.unmatchedCloses.length > 0) {
    const shown = a.unmatchedCloses.slice(0, MAX).map(
      (o) => `line ${o.line} col ${o.col}`
    ).join(", ");
    const extra = a.unmatchedCloses.length > MAX
      ? ` (… ${a.unmatchedCloses.length - MAX} more)` : "";
    parts.push(`  ${a.unmatchedCloses.length} unmatched ')' at ${shown}${extra}`);
  }
  if (a.unmatchedOpens.length === 0 && a.unmatchedCloses.length === 0) {
    const tail = source.slice(-120).replace(/\n/g, " ⏎ ");
    parts.push(`  (analyzer sees balanced parens; likely string/comment edge case) source tail: …${tail}`);
  }
  return parts.join("\n");
}

async function evaluate(env: any, source: string, timeoutMs: number) {
  const preprocessed = preprocessSchemeSource(source);
  // Install a per-eval stdout buffer so (display …) output is captured into
  // the result instead of vanishing to console.log. Also override `display`
  // to drop LIPS' string-quoting (its default writes `"hello"` with literal
  // quote marks; R7RS display should be raw).
  const prevStdout = (env as any).get("stdout", { throwError: false });
  const prevDisplay = (env as any).get("display", { throwError: false });
  const buf: string[] = [];
  (env as any).set("stdout", {
    write: (...args: any[]) => {
      for (const a of args) buf.push(typeof a === "string" ? a : String(a));
    },
  });
  (env as any).set("display", (...args: any[]) => {
    const out = args.map((a) => {
      if (a === null || a === undefined) return "";
      if (typeof a === "string") return a;
      if (a && typeof (a as any).toString === "function") return (a as any).toString();
      return String(a);
    }).join("");
    buf.push(out);
  });
  try {
    const results = await Promise.race<any>([
      (lips as any).exec(preprocessed, env),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`scheme_eval timed out after ${timeoutMs}ms`)), timeoutMs),
      ),
    ]);
    const last = Array.isArray(results) && results.length > 0 ? results[results.length - 1] : undefined;
    const displayed = buf.join("");
    const lastFmt = format(last);
    // Combine: displayed output first, then last-expression value if non-empty
    // and not just a void-ish marker.
    const value = displayed && lastFmt
      ? displayed + (displayed.endsWith("\n") ? "" : "\n") + lastFmt
      : displayed || lastFmt;
    return { ok: true as const, value };
  } catch (e: any) {
    logErr("evaluate", e, { source: source.slice(0, 400) });
    let msg = e?.message ?? String(e);
    if (/[Uu]nbalanced parenthes/.test(msg)) {
      msg = formatParenDiagnostic(source, msg);
    } else if (/Bad escaped character in JSON|Unexpected.*JSON|JSON at position/.test(msg)) {
      msg = formatStringEscapeDiagnostic(source, msg);
    }
    return { ok: false as const, error: msg };
  } finally {
    if (prevStdout !== undefined) (env as any).set("stdout", prevStdout);
    if (prevDisplay !== undefined) (env as any).set("display", prevDisplay);
  }
}

// ── standard-library shims ───────────────────────────────────────
// LIPS ships a small subset of R7RS and almost no SRFI-1. Models trained on
// Racket/Chicken/Guile reach for the canonical names (equal?, member, take,
// iota, etc.) and hit "Unbound variable" — costing a retry round trip per
// gap. We pre-populate the most common ones so the model's first attempt
// works regardless of which Scheme dialect it learned from.
function installStdShims(env: any): void {
  const defineIfMissing = (name: string, fn: any) => {
    if ((env as any).get(name, { throwError: false }) === undefined) env.set(name, fn);
  };
  const pairToArray = (p: any): any[] => {
    const out: any[] = [];
    while (p instanceof Pair) { out.push(p.car); p = p.cdr; }
    return out;
  };
  const truthy = (v: any) => v !== false;

  // ── R7RS equality ─────────────────────────────────────────
  // LIPS wraps numbers as LNumber instances, so `===` fails on equal-valued
  // numbers from different sources. Handle the wrapper types before recursing.
  const atomEqual = (a: any, b: any): boolean => {
    if (a === b) return true;
    if (a instanceof LNumber && b instanceof LNumber) return a.cmp(b) === 0;
    if (typeof a === "number" && b instanceof LNumber) return LNumber(a).cmp(b) === 0;
    if (typeof b === "number" && a instanceof LNumber) return LNumber(b).cmp(a) === 0;
    if (a instanceof LSymbol && b instanceof LSymbol) return a.name === b.name;
    return false;
  };
  const lipsEqual = (a: any, b: any): boolean => {
    if (atomEqual(a, b)) return true;
    if (a == null || b == null) return a == b;
    if (a instanceof Pair && b instanceof Pair) {
      return lipsEqual(a.car, b.car) && lipsEqual(a.cdr, b.cdr);
    }
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) if (!lipsEqual(a[i], b[i])) return false;
      return true;
    }
    return false;
  };
  defineIfMissing("equal?", lipsEqual);
  defineIfMissing("eqv?", atomEqual);

  // ── R7RS list/member ─────────────────────────────────────
  defineIfMissing("list?", (v: any) => v === nil || v instanceof Pair);
  const memberLike = (eq: (a: any, b: any) => boolean) => (item: any, lst: any) => {
    let p = lst;
    while (p instanceof Pair) {
      if (eq(p.car, item)) return p;
      p = p.cdr;
    }
    return false;
  };
  defineIfMissing("member", memberLike(lipsEqual));
  defineIfMissing("memq", memberLike((a, b) => a === b));
  defineIfMissing("memv", memberLike((a, b) => a === b));
  defineIfMissing("assv", (item: any, lst: any) => {
    let p = lst;
    while (p instanceof Pair) {
      const e = p.car;
      if (e instanceof Pair && e.car === item) return e;
      p = p.cdr;
    }
    return false;
  });

  // ── SRFI-1 list helpers ──────────────────────────────────
  defineIfMissing("first",  (lst: any) => pairToArray(lst)[0]);
  defineIfMissing("second", (lst: any) => pairToArray(lst)[1]);
  defineIfMissing("third",  (lst: any) => pairToArray(lst)[2]);
  defineIfMissing("fourth", (lst: any) => pairToArray(lst)[3]);
  defineIfMissing("fifth",  (lst: any) => pairToArray(lst)[4]);
  defineIfMissing("last",   (lst: any) => { const a = pairToArray(lst); return a[a.length - 1]; });
  defineIfMissing("take",   (lst: any, n: any) => toSchemeList(pairToArray(lst).slice(0, Number(n))));
  defineIfMissing("drop",   (lst: any, n: any) => toSchemeList(pairToArray(lst).slice(Number(n))));
  defineIfMissing("take-while", (pred: any, lst: any) => {
    const out: any[] = [];
    for (const x of pairToArray(lst)) { if (!truthy(pred(x))) break; out.push(x); }
    return toSchemeList(out);
  });
  defineIfMissing("drop-while", (pred: any, lst: any) => {
    const a = pairToArray(lst); let i = 0;
    while (i < a.length && truthy(pred(a[i]))) i++;
    return toSchemeList(a.slice(i));
  });
  defineIfMissing("iota", (count: any, start: any, step: any) => {
    const n = Number(count);
    const s = start === undefined ? 0 : Number(start);
    const k = step === undefined ? 1 : Number(step);
    return toSchemeList(Array.from({ length: n }, (_, i) => s + i * k));
  });
  defineIfMissing("any",   (pred: any, lst: any) => pairToArray(lst).some((x) => truthy(pred(x))));
  defineIfMissing("every", (pred: any, lst: any) => pairToArray(lst).every((x) => truthy(pred(x))));
  defineIfMissing("count", (pred: any, lst: any) => pairToArray(lst).filter((x) => truthy(pred(x))).length);
  defineIfMissing("filter-map", (f: any, lst: any) => {
    const out: any[] = [];
    for (const x of pairToArray(lst)) { const r = f(x); if (truthy(r) && r != null) out.push(r); }
    return toSchemeList(out);
  });
  defineIfMissing("append-map", (f: any, lst: any) =>
    toSchemeList(pairToArray(lst).flatMap((x) => pairToArray(f(x)))));
  defineIfMissing("concatenate", (lol: any) =>
    toSchemeList(pairToArray(lol).flatMap(pairToArray)));
  defineIfMissing("remove", (pred: any, lst: any) =>
    toSchemeList(pairToArray(lst).filter((x) => !truthy(pred(x)))));
  defineIfMissing("delete", (item: any, lst: any) =>
    toSchemeList(pairToArray(lst).filter((x) => !lipsEqual(x, item))));
  defineIfMissing("delete-duplicates", (lst: any) => {
    const arr = pairToArray(lst);
    const out: any[] = [];
    for (const item of arr) if (!out.some((x) => lipsEqual(x, item))) out.push(item);
    return toSchemeList(out);
  });
  defineIfMissing("partition", (pred: any, lst: any) => {
    const t: any[] = []; const f: any[] = [];
    for (const x of pairToArray(lst)) (truthy(pred(x)) ? t : f).push(x);
    return new Pair(toSchemeList(t), toSchemeList(f));
  });
  defineIfMissing("fold-right", (f: any, init: any, lst: any) => {
    const a = pairToArray(lst); let acc = init;
    for (let i = a.length - 1; i >= 0; i--) acc = f(a[i], acc);
    return acc;
  });
  defineIfMissing("zip", (a: any, b: any) => {
    const xs = pairToArray(a); const ys = pairToArray(b);
    const n = Math.min(xs.length, ys.length);
    return toSchemeList(Array.from({ length: n }, (_, i) => toSchemeList([xs[i], ys[i]])));
  });

  // ── R7RS numeric predicates / ops ────────────────────────
  defineIfMissing("zero?",     (n: any) => Number(n) === 0);
  defineIfMissing("positive?", (n: any) => Number(n) > 0);
  defineIfMissing("negative?", (n: any) => Number(n) < 0);
  defineIfMissing("odd?",      (n: any) => Math.abs(Number(n)) % 2 === 1);
  defineIfMissing("even?",     (n: any) => Number(n) % 2 === 0);
  defineIfMissing("modulo",    (a: any, b: any) => { const m = Number(a) % Number(b); return (m < 0) === (Number(b) < 0) ? m : m + Number(b); });
  defineIfMissing("quotient",  (a: any, b: any) => Math.trunc(Number(a) / Number(b)));
  defineIfMissing("remainder", (a: any, b: any) => Number(a) % Number(b));
  defineIfMissing("expt",      (a: any, b: any) => Math.pow(Number(a), Number(b)));
  defineIfMissing("ceiling",   (n: any) => Math.ceil(Number(n)));

  // ── R7RS string ops ──────────────────────────────────────
  defineIfMissing("string=?",  (a: any, b: any) => String(a) === String(b));
  defineIfMissing("string<?",  (a: any, b: any) => String(a) < String(b));
  defineIfMissing("string>?",  (a: any, b: any) => String(a) > String(b));
  defineIfMissing("string-upcase",   (s: any) => String(s).toUpperCase());
  defineIfMissing("string-downcase", (s: any) => String(s).toLowerCase());
  defineIfMissing("string->list",    (s: any) => toSchemeList(Array.from(String(s))));
  defineIfMissing("list->string",    (lst: any) => pairToArray(lst).map(String).join(""));
  defineIfMissing("string-ref",      (s: any, i: any) => {
    const str = String(s);
    const idx = Math.floor(Number(i));
    return idx >= 0 && idx < str.length ? str[idx] : false;
  });
  defineIfMissing("string-trim-both", (s: any) => String(s).trim());
  defineIfMissing("identity", (x: any) => x);
  // Pattern can be string or (regexp "pat"). Racket (?i:…) / (?m:…) inline
  // flag groups are translated to JS RegExp flags.
  const compileRegex = (pat: any): RegExp => {
    if (pat instanceof RegExp) return pat;
    let p = String(pat);
    let flags = "";
    const m = /^\(\?([imsx]+):/.exec(p);
    if (m && p.endsWith(")")) {
      flags = m[1].replace(/x/g, ""); // JS doesn't support /x; drop silently
      p = p.slice(m[0].length, -1);
    }
    return new RegExp(p, flags);
  };
  defineIfMissing("regexp", (pat: any) => compileRegex(pat));
  const regexpMatch = (pat: any, s: any) => {
    if (typeof s !== "string") return false;
    const m = s.match(compileRegex(pat));
    return m ? toSchemeList(Array.from(m)) : false;
  };
  defineIfMissing("regexp-match", regexpMatch);
  defineIfMissing("string-match", regexpMatch);
  // Guile's `match:substring` indexes into a match result.
  defineIfMissing("match:substring", (m: any, i: any) => {
    if (m === false || m === null || m === undefined) return false;
    const idx = Math.floor(Number(i) || 0);
    if (m instanceof Pair) {
      let cur: any = m;
      let k = 0;
      while (cur instanceof Pair) {
        if (k === idx) return cur.car;
        cur = cur.cdr; k++;
      }
      return false;
    }
    return false;
  });
  defineIfMissing("regexp-match-positions", (pat: any, s: any) => {
    if (typeof s !== "string") return false;
    const m = s.match(compileRegex(pat));
    if (!m) return false;
    const start = m.index ?? 0;
    const full = new Pair(new LNumber(start), new LNumber(start + m[0].length));
    return new Pair(full, nil);
  });

  // ── Racket spellings ─────────────────────────────────────
  defineIfMissing("string-split", (s: any, sep: any) => {
    if (typeof s !== "string") return nil;
    if (sep === undefined) return toSchemeList(s.split(/\s+/).filter(Boolean));
    return toSchemeList(s.split(String(sep)));
  });
  defineIfMissing("string-join", (lst: any, sep: any) =>
    pairToArray(lst).map(String).join(sep === undefined ? " " : String(sep)));
  defineIfMissing("displayln", function (this: any, x: any) {
    const display = (env as any).get("display", { throwError: false });
    if (display) { display(x); display("\n"); }
  });

  // ── R7RS error/exit ──────────────────────────────────────
  defineIfMissing("error", (...msgs: any[]) => {
    throw new Error(msgs.map((m) => (typeof m === "string" ? m : String(m))).join(" "));
  });
  defineIfMissing("void", () => undefined);

  // ── R7RS write (LIPS' display is good enough; write quotes strings) ──
  defineIfMissing("write", function (this: any, x: any) {
    const display = (env as any).get("display", { throwError: false });
    if (display) display(typeof x === "string" ? JSON.stringify(x) : x);
  });

  // ── R7RS numbers (gaps) ────────────────────────────────────
  defineIfMissing("abs",       (n: any) => Math.abs(Number(n)));
  defineIfMissing("floor",     (n: any) => Math.floor(Number(n)));
  defineIfMissing("round",     (n: any) => Math.round(Number(n)));
  defineIfMissing("truncate",  (n: any) => Math.trunc(Number(n)));
  defineIfMissing("sqrt",      (n: any) => Math.sqrt(Number(n)));
  defineIfMissing("log",       (n: any, base: any) =>
    base === undefined ? Math.log(Number(n)) : Math.log(Number(n)) / Math.log(Number(base)));
  defineIfMissing("exp",       (n: any) => Math.exp(Number(n)));
  defineIfMissing("sin",       (n: any) => Math.sin(Number(n)));
  defineIfMissing("cos",       (n: any) => Math.cos(Number(n)));
  defineIfMissing("tan",       (n: any) => Math.tan(Number(n)));
  defineIfMissing("asin",      (n: any) => Math.asin(Number(n)));
  defineIfMissing("acos",      (n: any) => Math.acos(Number(n)));
  defineIfMissing("atan",      (a: any, b: any) =>
    b === undefined ? Math.atan(Number(a)) : Math.atan2(Number(a), Number(b)));
  defineIfMissing("gcd", (...args: any[]) => {
    const gcd2 = (a: number, b: number): number => b === 0 ? Math.abs(a) : gcd2(b, a % b);
    return args.length === 0 ? 0 : args.map(Number).reduce(gcd2);
  });
  defineIfMissing("lcm", (...args: any[]) => {
    const gcd2 = (a: number, b: number): number => b === 0 ? Math.abs(a) : gcd2(b, a % b);
    const lcm2 = (a: number, b: number): number => a && b ? Math.abs(a * b) / gcd2(a, b) : 0;
    return args.length === 0 ? 1 : args.map(Number).reduce(lcm2);
  });
  defineIfMissing("exact",         (n: any) => Math.round(Number(n)));
  defineIfMissing("inexact",       (n: any) => Number(n));
  defineIfMissing("exact->inexact", (n: any) => Number(n));
  defineIfMissing("inexact->exact", (n: any) => Math.round(Number(n)));
  defineIfMissing("exact-integer?", (n: any) => Number.isInteger(Number(n)));
  defineIfMissing("exact?",   (n: any) => Number.isInteger(Number(n)));
  defineIfMissing("inexact?", (n: any) => !Number.isInteger(Number(n)));
  defineIfMissing("=", (...args: any[]) => {
    if (args.length < 2) return true;
    const first = Number(args[0]);
    for (let i = 1; i < args.length; i++) if (Number(args[i]) !== first) return false;
    return true;
  });
  defineIfMissing("finite?",        (n: any) => Number.isFinite(Number(n)));
  defineIfMissing("infinite?",      (n: any) => !Number.isFinite(Number(n)) && !Number.isNaN(Number(n)));
  defineIfMissing("nan?",           (n: any) => Number.isNaN(Number(n)));
  defineIfMissing("add1", (n: any) => Number(n) + 1);
  defineIfMissing("sub1", (n: any) => Number(n) - 1);
  defineIfMissing("sqr",  (n: any) => Number(n) * Number(n));

  // ── R7RS predicates ────────────────────────────────────────
  defineIfMissing("boolean?",   (x: any) => x === true || x === false);
  defineIfMissing("boolean=?",  (a: any, b: any) => a === b && (a === true || a === false));
  defineIfMissing("procedure?", (x: any) => typeof x === "function");
  defineIfMissing("symbol?",    (x: any) => x instanceof LSymbol);
  defineIfMissing("symbol=?",   (a: any, b: any) =>
    a instanceof LSymbol && b instanceof LSymbol && (a as any).name === (b as any).name);
  defineIfMissing("string->symbol", (s: any) => new LSymbol(String(s)));
  defineIfMissing("integer?", (x: any) => typeof x === "number" ? Number.isInteger(x)
    : (x && typeof x.valueOf === "function" && Number.isInteger(Number(x.valueOf()))));

  // ── R7RS strings (gaps) ────────────────────────────────────
  defineIfMissing("substring", (s: any, start: any, end: any) => {
    const str = String(s);
    const a = Math.max(0, Math.floor(Number(start) || 0));
    const b = end === undefined ? str.length : Math.min(str.length, Math.floor(Number(end)));
    return str.slice(a, b);
  });
  defineIfMissing("string-copy", (s: any) => String(s));
  defineIfMissing("make-string", (n: any, ch?: any) => {
    const len = Math.max(0, Math.floor(Number(n) || 0));
    const c = ch === undefined ? " " : String(ch);
    return c.length === 1 ? c.repeat(len) : (c + "").repeat(len).slice(0, len);
  });
  defineIfMissing("string-foldcase", (s: any) => String(s).toLowerCase());
  defineIfMissing("string-trim",       (s: any) => String(s).trim());
  defineIfMissing("string-trim-left",  (s: any) => String(s).replace(/^\s+/, ""));
  defineIfMissing("string-trim-right", (s: any) => String(s).replace(/\s+$/, ""));
  defineIfMissing("string-prefix?", (prefix: any, s: any) =>
    String(s).startsWith(String(prefix)));
  defineIfMissing("string-suffix?", (suffix: any, s: any) =>
    String(s).endsWith(String(suffix)));
  defineIfMissing("non-empty-string?", (x: any) =>
    typeof x === "string" && x.length > 0);
  defineIfMissing("string-index", (s: any, needle: any) => {
    const i = String(s).indexOf(String(needle));
    return i < 0 ? false : i;
  });
  defineIfMissing("string-ci=?", (a: any, b: any) =>
    String(a).toLowerCase() === String(b).toLowerCase());
  defineIfMissing("string-ci<?", (a: any, b: any) =>
    String(a).toLowerCase() < String(b).toLowerCase());
  defineIfMissing("string-ci>?", (a: any, b: any) =>
    String(a).toLowerCase() > String(b).toLowerCase());
  defineIfMissing("string<=?",   (a: any, b: any) => String(a) <= String(b));
  defineIfMissing("string>=?",   (a: any, b: any) => String(a) >= String(b));

  // ── R7RS / SRFI-1 list gaps ────────────────────────────────
  defineIfMissing("list-tail", (lst: any, n: any) => {
    let k = Math.floor(Number(n) || 0);
    let cur: any = lst;
    while (k-- > 0 && cur instanceof Pair) cur = cur.cdr;
    return cur;
  });
  defineIfMissing("list-ref", (lst: any, n: any) => {
    let k = Math.floor(Number(n) || 0);
    let cur: any = lst;
    while (k-- > 0 && cur instanceof Pair) cur = cur.cdr;
    return cur instanceof Pair ? cur.car : false;
  });
  defineIfMissing("list-index", (pred: any, lst: any) => {
    let i = 0, cur: any = lst;
    while (cur instanceof Pair) {
      if (truthy(pred(cur.car))) return i;
      cur = cur.cdr; i++;
    }
    return false;
  });
  defineIfMissing("last-pair", (lst: any) => {
    let cur: any = lst;
    while (cur instanceof Pair && cur.cdr instanceof Pair) cur = cur.cdr;
    return cur;
  });
  defineIfMissing("length+", (lst: any) => {
    let n = 0, slow: any = lst, fast: any = lst;
    while (fast instanceof Pair) {
      n++;
      fast = fast.cdr;
      if (!(fast instanceof Pair)) break;
      n++;
      fast = fast.cdr;
      slow = slow.cdr;
      if (fast === slow) return false; // cycle
    }
    return n;
  });
  defineIfMissing("list-tabulate", (n: any, init: any) => {
    const count = Math.max(0, Math.floor(Number(n) || 0));
    const out: any[] = [];
    for (let i = 0; i < count; i++) out.push(init(i));
    return toSchemeList(out);
  });
  defineIfMissing("cons*", (...args: any[]) => {
    if (args.length === 0) return nil;
    if (args.length === 1) return args[0];
    let tail: any = args[args.length - 1];
    for (let i = args.length - 2; i >= 0; i--) tail = new Pair(args[i], tail);
    return tail;
  });
  defineIfMissing("list*", (...args: any[]) => {
    if (args.length === 0) return nil;
    if (args.length === 1) return args[0];
    let tail: any = args[args.length - 1];
    for (let i = args.length - 2; i >= 0; i--) tail = new Pair(args[i], tail);
    return tail;
  });
  defineIfMissing("append-reverse", (a: any, b: any) => {
    let cur: any = a, out: any = b;
    while (cur instanceof Pair) { out = new Pair(cur.car, out); cur = cur.cdr; }
    return out;
  });
  defineIfMissing("reduce-right", (f: any, init: any, lst: any) => {
    const arr = pairToArray(lst);
    if (arr.length === 0) return init;
    return arr.reduceRight((acc: any, x: any) => f(x, acc));
  });
  defineIfMissing("span", (pred: any, lst: any) => {
    const taken: any[] = [];
    let cur: any = lst;
    while (cur instanceof Pair && truthy(pred(cur.car))) {
      taken.push(cur.car);
      cur = cur.cdr;
    }
    return new Pair(toSchemeList(taken), cur);
  });
  defineIfMissing("break", (pred: any, lst: any) => {
    const taken: any[] = [];
    let cur: any = lst;
    while (cur instanceof Pair && !truthy(pred(cur.car))) {
      taken.push(cur.car);
      cur = cur.cdr;
    }
    return new Pair(toSchemeList(taken), cur);
  });
  // SRFI-1 association list helpers
  defineIfMissing("alist-cons", (k: any, v: any, alist: any) =>
    new Pair(new Pair(k, v), alist));
  defineIfMissing("alist-copy", (alist: any) => {
    const out: any[] = [];
    let cur: any = alist;
    while (cur instanceof Pair) {
      const e = cur.car;
      if (e instanceof Pair) out.push(new Pair(e.car, e.cdr));
      else out.push(e);
      cur = cur.cdr;
    }
    return toSchemeList(out);
  });
  // LIPS' `range` is single-arg only; override (not defineIfMissing) so the
  // 1/2/3-arg Racket form wins.
  env.set("range", (a: any, b: any, step: any) => {
    let start: number, end: number, st: number;
    if (b === undefined) { start = 0; end = Number(a); st = 1; }
    else { start = Number(a); end = Number(b); st = step === undefined ? 1 : Number(step); }
    const out: number[] = [];
    if (st > 0) for (let i = start; i < end; i += st) out.push(i);
    else if (st < 0) for (let i = start; i > end; i += st) out.push(i);
    return toSchemeList(out);
  });
  defineIfMissing("flatten", (lst: any) => {
    const out: any[] = [];
    const walk = (x: any) => {
      if (x instanceof Pair) { let c: any = x; while (c instanceof Pair) { walk(c.car); c = c.cdr; } }
      else if (x !== nil) out.push(x);
    };
    walk(lst);
    return toSchemeList(out);
  });
  defineIfMissing("index-of", (lst: any, x: any) => {
    let i = 0, cur: any = lst;
    while (cur instanceof Pair) {
      if (atomEqual(cur.car, x)) return i;
      cur = cur.cdr; i++;
    }
    return false;
  });
  defineIfMissing("argmax", (key: any, lst: any) => {
    let best: any = false, bestKey: number = -Infinity;
    let cur: any = lst;
    while (cur instanceof Pair) {
      const k = Number(key(cur.car));
      if (k > bestKey) { bestKey = k; best = cur.car; }
      cur = cur.cdr;
    }
    return best;
  });
  defineIfMissing("argmin", (key: any, lst: any) => {
    let best: any = false, bestKey: number = Infinity;
    let cur: any = lst;
    while (cur instanceof Pair) {
      const k = Number(key(cur.car));
      if (k < bestKey) { bestKey = k; best = cur.car; }
      cur = cur.cdr;
    }
    return best;
  });
  defineIfMissing("remove-duplicates", (lst: any, same?: any) => {
    const eq = typeof same === "function" ? same : atomEqual;
    const out: any[] = [];
    let cur: any = lst;
    while (cur instanceof Pair) {
      if (!out.some((y) => eq(y, cur.car))) out.push(cur.car);
      cur = cur.cdr;
    }
    return toSchemeList(out);
  });
  defineIfMissing("group-by", (key: any, lst: any) => {
    const groups: Array<{ k: any; items: any[] }> = [];
    let cur: any = lst;
    while (cur instanceof Pair) {
      const k = key(cur.car);
      let g = groups.find((g) => atomEqual(g.k, k));
      if (!g) { g = { k, items: [] }; groups.push(g); }
      g.items.push(cur.car);
      cur = cur.cdr;
    }
    return toSchemeList(groups.map((g) => toSchemeList(g.items)));
  });

  // ── Regex (Racket) ─────────────────────────────────────────
  const reCompile = (pat: any): RegExp => {
    if (pat instanceof RegExp) return pat;
    let p = String(pat);
    let flags = "";
    const m = /^\(\?([imsx]+):/.exec(p);
    if (m && p.endsWith(")")) {
      flags = m[1].replace(/x/g, "");
      p = p.slice(m[0].length, -1);
    }
    return new RegExp(p, flags);
  };
  defineIfMissing("regexp?", (x: any) => x instanceof RegExp);
  defineIfMissing("regexp-replace", (pat: any, s: any, repl: any) => {
    if (typeof s !== "string") return s;
    return s.replace(reCompile(pat), String(repl));
  });
  defineIfMissing("regexp-replace*", (pat: any, s: any, repl: any) => {
    if (typeof s !== "string") return s;
    const re = reCompile(pat);
    const global = re.flags.includes("g") ? re : new RegExp(re.source, re.flags + "g");
    return s.replace(global, String(repl));
  });
  defineIfMissing("regexp-quote", (s: any) =>
    String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  defineIfMissing("regexp-split", (pat: any, s: any) =>
    typeof s === "string" ? toSchemeList(s.split(reCompile(pat))) : nil);

  // ── Format (Racket) ────────────────────────────────────────
  // format: simple ~a ~s ~v ~n support — covers most logging/inspection
  defineIfMissing("format", (fmt: any, ...rest: any[]) => {
    const f = String(fmt);
    let i = 0;
    return f.replace(/~(.)/g, (_: any, c: string) => {
      switch (c) {
        case "a": return rest[i] === undefined ? "" : (typeof rest[i++] === "string" ? rest[i-1] : (rest[i-1]).toString());
        case "s":
        case "v": { const v = rest[i++]; return typeof v === "string" ? JSON.stringify(v) : (v === undefined ? "" : v.toString()); }
        case "n":
        case "%": return "\n";
        case "~": return "~";
        default:  return "~" + c;
      }
    });
  });
  defineIfMissing("printf", function (this: any, fmt: any, ...rest: any[]) {
    const format = (env as any).get("format", { throwError: false });
    const display = (env as any).get("display", { throwError: false });
    if (format && display) display(format(fmt, ...rest));
  });
  defineIfMissing("~a", (...xs: any[]) =>
    xs.map((x) => x === undefined ? "" : (typeof x === "string" ? x : x.toString())).join(""));
  defineIfMissing("~s", (...xs: any[]) =>
    xs.map((x) => typeof x === "string" ? JSON.stringify(x) : (x === undefined ? "" : x.toString())).join(""));
  defineIfMissing("~v", (...xs: any[]) =>
    xs.map((x) => typeof x === "string" ? JSON.stringify(x) : (x === undefined ? "" : x.toString())).join(""));

  // ── Hash tables (Racket) ───────────────────────────────────
  // Backed by JS Map. Stored as `LipsHash` symbol so we can pattern-match.
  class LipsHash {
    map: Map<any, any> = new Map();
    constructor(entries?: Array<[any, any]>) {
      if (entries) for (const [k, v] of entries) this.map.set(this._key(k), v);
    }
    _key(k: any): any {
      if (k instanceof LSymbol) return "::sym::" + (k as any).name;
      if (typeof k === "object" && k !== null) return JSON.stringify(k);
      return k;
    }
    get(k: any, dflt: any = false) {
      const key = this._key(k);
      return this.map.has(key) ? this.map.get(key) : dflt;
    }
    set(k: any, v: any) { this.map.set(this._key(k), v); return this; }
    has(k: any) { return this.map.has(this._key(k)); }
    remove(k: any) { this.map.delete(this._key(k)); return this; }
    keys() { return Array.from(this.map.keys()).map((k) =>
      typeof k === "string" && k.startsWith("::sym::") ? new LSymbol(k.slice(7)) : k); }
    values() { return Array.from(this.map.values()); }
    size() { return this.map.size; }
  }
  defineIfMissing("make-hash", (alist?: any) => {
    const h = new LipsHash();
    if (alist instanceof Pair) {
      let cur: any = alist;
      while (cur instanceof Pair) {
        const e = cur.car;
        if (e instanceof Pair) h.set(e.car, e.cdr);
        cur = cur.cdr;
      }
    }
    return h;
  });
  defineIfMissing("hash", (...args: any[]) => {
    const h = new LipsHash();
    for (let i = 0; i + 1 < args.length; i += 2) h.set(args[i], args[i + 1]);
    return h;
  });
  defineIfMissing("hash?", (x: any) => x instanceof LipsHash);
  defineIfMissing("hash-ref", (h: any, k: any, dflt: any = false) =>
    h instanceof LipsHash ? h.get(k, dflt) : dflt);
  defineIfMissing("hash-set!", (h: any, k: any, v: any) => {
    if (h instanceof LipsHash) h.set(k, v);
    return h;
  });
  defineIfMissing("hash-set", (h: any, k: any, v: any) => {
    if (!(h instanceof LipsHash)) return h;
    const out = new LipsHash();
    h.map.forEach((vv: any, kk: any) => out.map.set(kk, vv));
    out.map.set(out._key(k), v);
    return out;
  });
  defineIfMissing("hash-remove!", (h: any, k: any) => {
    if (h instanceof LipsHash) h.remove(k);
    return h;
  });
  defineIfMissing("hash-has-key?", (h: any, k: any) =>
    h instanceof LipsHash && h.has(k));
  defineIfMissing("hash-keys",   (h: any) => h instanceof LipsHash ? toSchemeList(h.keys()) : nil);
  defineIfMissing("hash-values", (h: any) => h instanceof LipsHash ? toSchemeList(h.values()) : nil);
  defineIfMissing("hash-count",  (h: any) => h instanceof LipsHash ? h.size() : 0);

  // ── Sort (R7RS-large / SRFI-132 / Racket) ──────────────────
  // V8's Array.prototype.sort is stable (ES2019), so one impl serves all.
  const sortImpl = (lst: any, less: any) => {
    const arr = pairToArray(lst).slice();
    arr.sort((a, b) => (truthy(less(a, b)) ? -1 : truthy(less(b, a)) ? 1 : 0));
    return toSchemeList(arr);
  };
  defineIfMissing("sort",  sortImpl);
  defineIfMissing("sort!", sortImpl);
  // SRFI-132 / R7RS-large flips the argument order.
  defineIfMissing("list-sort", (less: any, lst: any) => sortImpl(lst, less));

  // ── Racket list aliases & gaps ─────────────────────────────
  defineIfMissing("empty?", (v: any) => v === nil);
  defineIfMissing("empty",  nil);
  defineIfMissing("cons?",  (v: any) => v instanceof Pair);
  defineIfMissing("andmap", (pred: any, lst: any) => pairToArray(lst).every((x) => truthy(pred(x))));
  defineIfMissing("ormap",  (pred: any, lst: any) => pairToArray(lst).some((x) => truthy(pred(x))));
  defineIfMissing("findf",  (pred: any, lst: any) => {
    for (const x of pairToArray(lst)) if (truthy(pred(x))) return x;
    return false;
  });
  defineIfMissing("assf", (pred: any, lst: any) => {
    let cur: any = lst;
    while (cur instanceof Pair) {
      const e = cur.car;
      if (e instanceof Pair && truthy(pred(e.car))) return e;
      cur = cur.cdr;
    }
    return false;
  });
  defineIfMissing("make-list", (n: any, v: any) => {
    const count = Math.max(0, Math.floor(Number(n) || 0));
    const fill = v === undefined ? nil : v;
    return toSchemeList(Array(count).fill(fill));
  });
  defineIfMissing("build-list", (n: any, proc: any) => {
    const count = Math.max(0, Math.floor(Number(n) || 0));
    const out: any[] = [];
    for (let i = 0; i < count; i++) out.push(proc(i));
    return toSchemeList(out);
  });
  defineIfMissing("take-right", (lst: any, n: any) => {
    const a = pairToArray(lst);
    const k = Math.max(0, Math.floor(Number(n) || 0));
    return toSchemeList(a.slice(a.length - k));
  });
  defineIfMissing("drop-right", (lst: any, n: any) => {
    const a = pairToArray(lst);
    const k = Math.max(0, Math.floor(Number(n) || 0));
    return toSchemeList(a.slice(0, Math.max(0, a.length - k)));
  });
  defineIfMissing("split-at", (lst: any, n: any) => {
    const a = pairToArray(lst);
    const k = Math.max(0, Math.floor(Number(n) || 0));
    return new Pair(toSchemeList(a.slice(0, k)), toSchemeList(a.slice(k)));
  });
  defineIfMissing("shuffle", (lst: any) => {
    const a = pairToArray(lst).slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return toSchemeList(a);
  });
  defineIfMissing("add-between", (lst: any, sep: any) => {
    const a = pairToArray(lst);
    if (a.length < 2) return toSchemeList(a);
    const out: any[] = [a[0]];
    for (let i = 1; i < a.length; i++) { out.push(sep); out.push(a[i]); }
    return toSchemeList(out);
  });
  defineIfMissing("remf", (pred: any, lst: any) => {
    const a = pairToArray(lst);
    const i = a.findIndex((x) => truthy(pred(x)));
    return i < 0 ? lst : toSchemeList(a.slice(0, i).concat(a.slice(i + 1)));
  });
  defineIfMissing("remf*", (pred: any, lst: any) =>
    toSchemeList(pairToArray(lst).filter((x) => !truthy(pred(x)))));
  defineIfMissing("rest",    (lst: any) => lst instanceof Pair ? lst.cdr : nil);
  defineIfMissing("sixth",   (lst: any) => pairToArray(lst)[5]);
  defineIfMissing("seventh", (lst: any) => pairToArray(lst)[6]);
  defineIfMissing("eighth",  (lst: any) => pairToArray(lst)[7]);
  defineIfMissing("ninth",   (lst: any) => pairToArray(lst)[8]);
  defineIfMissing("tenth",   (lst: any) => pairToArray(lst)[9]);
  defineIfMissing("index-where", (lst: any, pred: any) => {
    let i = 0, cur: any = lst;
    while (cur instanceof Pair) {
      if (truthy(pred(cur.car))) return i;
      cur = cur.cdr; i++;
    }
    return false;
  });
  defineIfMissing("indexes-of", (lst: any, x: any) => {
    const out: number[] = [];
    let i = 0, cur: any = lst;
    while (cur instanceof Pair) {
      if (lipsEqual(cur.car, x)) out.push(i);
      cur = cur.cdr; i++;
    }
    return toSchemeList(out);
  });
  defineIfMissing("list-update", (lst: any, i: any, upd: any) => {
    const a = pairToArray(lst).slice();
    const k = Math.floor(Number(i) || 0);
    if (k >= 0 && k < a.length) a[k] = upd(a[k]);
    return toSchemeList(a);
  });
  defineIfMissing("list-set", (lst: any, i: any, v: any) => {
    const a = pairToArray(lst).slice();
    const k = Math.floor(Number(i) || 0);
    if (k >= 0 && k < a.length) a[k] = v;
    return toSchemeList(a);
  });
  defineIfMissing("list-prefix?", (a: any, b: any) => {
    const xs = pairToArray(a); const ys = pairToArray(b);
    if (xs.length > ys.length) return false;
    for (let i = 0; i < xs.length; i++) if (!lipsEqual(xs[i], ys[i])) return false;
    return true;
  });
  defineIfMissing("split-at-right", (lst: any, n: any) => {
    const a = pairToArray(lst);
    const k = Math.max(0, Math.floor(Number(n) || 0));
    const cut = Math.max(0, a.length - k);
    return new Pair(toSchemeList(a.slice(0, cut)), toSchemeList(a.slice(cut)));
  });
  defineIfMissing("takef", (lst: any, pred: any) => {
    const out: any[] = [];
    for (const x of pairToArray(lst)) { if (!truthy(pred(x))) break; out.push(x); }
    return toSchemeList(out);
  });
  defineIfMissing("dropf", (lst: any, pred: any) => {
    const a = pairToArray(lst); let i = 0;
    while (i < a.length && truthy(pred(a[i]))) i++;
    return toSchemeList(a.slice(i));
  });
  defineIfMissing("memf", (pred: any, lst: any) => {
    let cur: any = lst;
    while (cur instanceof Pair) {
      if (truthy(pred(cur.car))) return cur;
      cur = cur.cdr;
    }
    return false;
  });
  defineIfMissing("append*", (...args: any[]) => {
    if (args.length === 0) return nil;
    const leading = args.slice(0, -1).flatMap(pairToArray);
    const tail = pairToArray(args[args.length - 1]).flatMap(pairToArray);
    return toSchemeList(leading.concat(tail));
  });
  defineIfMissing("filter-not", (pred: any, lst: any) =>
    toSchemeList(pairToArray(lst).filter((x) => !truthy(pred(x)))));
  defineIfMissing("check-duplicates", (lst: any) => {
    const seen: any[] = [];
    for (const x of pairToArray(lst)) {
      if (seen.some((y) => lipsEqual(y, x))) return x;
      seen.push(x);
    }
    return false;
  });
  defineIfMissing("cartesian-product", (...lists: any[]) => {
    if (lists.length === 0) return toSchemeList([toSchemeList([])]);
    const arrs = lists.map(pairToArray);
    let acc: any[][] = [[]];
    for (const arr of arrs) {
      const next: any[][] = [];
      for (const prefix of acc) for (const x of arr) next.push(prefix.concat([x]));
      acc = next;
    }
    return toSchemeList(acc.map(toSchemeList));
  });
  defineIfMissing("inclusive-range", (a: any, b: any, step: any) => {
    let start: number, end: number, st: number;
    if (b === undefined) { start = 0; end = Number(a); st = 1; }
    else { start = Number(a); end = Number(b); st = step === undefined ? 1 : Number(step); }
    const out: number[] = [];
    if (st > 0) for (let i = start; i <= end; i += st) out.push(i);
    else if (st < 0) for (let i = start; i >= end; i += st) out.push(i);
    return toSchemeList(out);
  });
  defineIfMissing("remove*", (vs: any, lst: any) => {
    const arr = pairToArray(lst);
    const targets = vs instanceof Pair ? pairToArray(vs) : [vs];
    return toSchemeList(arr.filter((x) => !targets.some((t) => lipsEqual(t, x))));
  });

  // ── Racket numbers (gaps) ──────────────────────────────────
  defineIfMissing("pi", Math.PI);
  // Racket overloads: (random) 0≤x<1, (random k) 0≤i<k, (random lo hi).
  defineIfMissing("random", (a: any, b: any) => {
    if (a === undefined) return Math.random();
    if (b === undefined) return Math.floor(Math.random() * Math.max(0, Math.floor(Number(a))));
    const lo = Math.floor(Number(a));
    const hi = Math.floor(Number(b));
    return lo + Math.floor(Math.random() * Math.max(0, hi - lo));
  });
  defineIfMissing("exact-floor",    (n: any) => Math.floor(Number(n)));
  defineIfMissing("exact-ceiling",  (n: any) => Math.ceil(Number(n)));
  defineIfMissing("exact-round",    (n: any) => Math.round(Number(n)));
  defineIfMissing("exact-truncate", (n: any) => Math.trunc(Number(n)));
  defineIfMissing("sgn",   (n: any) => { const x = Number(n); return x > 0 ? 1 : x < 0 ? -1 : 0; });
  defineIfMissing("sinh",  (n: any) => Math.sinh(Number(n)));
  defineIfMissing("cosh",  (n: any) => Math.cosh(Number(n)));
  defineIfMissing("tanh",  (n: any) => Math.tanh(Number(n)));
  defineIfMissing("degrees->radians", (n: any) => Number(n) * Math.PI / 180);
  defineIfMissing("radians->degrees", (n: any) => Number(n) * 180 / Math.PI);
  defineIfMissing("natural?",          (n: any) => Number.isInteger(Number(n)) && Number(n) >= 0);
  defineIfMissing("positive-integer?", (n: any) => Number.isInteger(Number(n)) && Number(n) > 0);
  defineIfMissing("negative-integer?", (n: any) => Number.isInteger(Number(n)) && Number(n) < 0);
  defineIfMissing("real->decimal-string", (n: any, digits: any) => {
    const d = digits === undefined ? 6 : Math.max(0, Math.floor(Number(digits)));
    return Number(n).toFixed(d);
  });

  // ── Racket strings & chars (gaps) ──────────────────────────
  defineIfMissing("string-titlecase", (s: any) =>
    String(s).replace(/\b([a-z])/g, (_, c) => c.toUpperCase()));
  defineIfMissing("string-pad", (s: any, width: any, ch?: any) => {
    const str = String(s);
    const w = Math.max(0, Math.floor(Number(width) || 0));
    const c = ch === undefined ? " " : String(ch).charAt(0) || " ";
    return str.length >= w ? str : c.repeat(w - str.length) + str;
  });
  defineIfMissing("string-pad-right", (s: any, width: any, ch?: any) => {
    const str = String(s);
    const w = Math.max(0, Math.floor(Number(width) || 0));
    const c = ch === undefined ? " " : String(ch).charAt(0) || " ";
    return str.length >= w ? str : str + c.repeat(w - str.length);
  });
  defineIfMissing("char-upcase",   (c: any) => String(c).toUpperCase());
  defineIfMissing("char-downcase", (c: any) => String(c).toLowerCase());
  defineIfMissing("string-normalize-spaces", (s: any, sep?: any, repl?: any) => {
    const str = String(s).trim();
    const splitOn = sep === undefined ? /\s+/ : (sep instanceof RegExp ? sep : new RegExp(String(sep)));
    const joiner = repl === undefined ? " " : String(repl);
    return str.split(splitOn).filter(Boolean).join(joiner);
  });
  defineIfMissing("build-string", (n: any, proc: any) => {
    const count = Math.max(0, Math.floor(Number(n) || 0));
    let out = "";
    for (let i = 0; i < count; i++) out += String(proc(i));
    return out;
  });

  // ── Racket hash (gaps) ─────────────────────────────────────
  defineIfMissing("hash-update!", (h: any, k: any, upd: any, dflt: any) => {
    if (!(h instanceof LipsHash)) return h;
    const cur = h.has(k) ? h.get(k) : (typeof dflt === "function" ? dflt() : dflt);
    h.set(k, upd(cur));
    return h;
  });
  defineIfMissing("hash-update", (h: any, k: any, upd: any, dflt: any) => {
    if (!(h instanceof LipsHash)) return h;
    const out = new LipsHash();
    h.map.forEach((vv: any, kk: any) => out.map.set(kk, vv));
    const cur = h.has(k) ? h.get(k) : (typeof dflt === "function" ? dflt() : dflt);
    out.map.set(out._key(k), upd(cur));
    return out;
  });
  defineIfMissing("hash-map", (h: any, proc: any) => {
    if (!(h instanceof LipsHash)) return nil;
    const out: any[] = [];
    const keys = h.keys();
    for (const k of keys) out.push(proc(k, h.get(k)));
    return toSchemeList(out);
  });
  defineIfMissing("hash-for-each", (h: any, proc: any) => {
    if (!(h instanceof LipsHash)) return undefined;
    for (const k of h.keys()) proc(k, h.get(k));
    return undefined;
  });
  defineIfMissing("hash->list", (h: any) => {
    if (!(h instanceof LipsHash)) return nil;
    return toSchemeList(h.keys().map((k: any) => new Pair(k, h.get(k))));
  });
  defineIfMissing("hash-empty?", (h: any) => h instanceof LipsHash && h.size() === 0);
  defineIfMissing("hash-clear!", (h: any) => {
    if (h instanceof LipsHash) h.map.clear();
    return h;
  });
  defineIfMissing("hash-copy", (h: any) => {
    if (!(h instanceof LipsHash)) return h;
    const out = new LipsHash();
    h.map.forEach((vv: any, kk: any) => out.map.set(kk, vv));
    return out;
  });
  defineIfMissing("hash-ref!", (h: any, k: any, dflt: any) => {
    if (!(h instanceof LipsHash)) return dflt;
    if (h.has(k)) return h.get(k);
    const v = typeof dflt === "function" ? dflt() : dflt;
    h.set(k, v);
    return v;
  });
  defineIfMissing("hash-remove", (h: any, k: any) => {
    if (!(h instanceof LipsHash)) return h;
    const out = new LipsHash();
    h.map.forEach((vv: any, kk: any) => out.map.set(kk, vv));
    out.map.delete(out._key(k));
    return out;
  });
  // Combiner is the optional last positional arg (Racket uses #:combine).
  defineIfMissing("hash-union", (...args: any[]) => {
    let combine: ((a: any, b: any) => any) | null = null;
    if (args.length > 0 && typeof args[args.length - 1] === "function" && !(args[args.length - 1] instanceof LipsHash)) {
      combine = args.pop();
    }
    const out = new LipsHash();
    for (const h of args) {
      if (!(h instanceof LipsHash)) continue;
      h.map.forEach((vv: any, kk: any) => {
        if (combine && out.map.has(kk)) out.map.set(kk, combine(out.map.get(kk), vv));
        else out.map.set(kk, vv);
      });
    }
    return out;
  });
  // eq?/eqv? variants alias to the equal? impl — JS can't distinguish identity.
  defineIfMissing("hasheq",                (...a: any[]) => (env as any).get("hash")(...a));
  defineIfMissing("hasheqv",               (...a: any[]) => (env as any).get("hash")(...a));
  defineIfMissing("make-hasheq",           (alist?: any) => (env as any).get("make-hash")(alist));
  defineIfMissing("make-hasheqv",          (alist?: any) => (env as any).get("make-hash")(alist));
  defineIfMissing("make-immutable-hash",   (alist?: any) => (env as any).get("make-hash")(alist));

  // ── Racket boxes (mutable cells) ───────────────────────────
  class LipsBox { constructor(public v: any) {} }
  defineIfMissing("box",      (v: any) => new LipsBox(v));
  defineIfMissing("box?",     (x: any) => x instanceof LipsBox);
  defineIfMissing("unbox",    (b: any) => b instanceof LipsBox ? b.v : b);
  defineIfMissing("set-box!", (b: any, v: any) => { if (b instanceof LipsBox) b.v = v; return undefined; });

  // ── Environment introspection ──────────────────────────────
  const collectEnvNames = (): string[] => {
    const seen = new Set<string>();
    let cur: any = env;
    while (cur) {
      const frame = cur.env;
      if (frame && typeof frame === "object") for (const k of Object.keys(frame)) seen.add(k);
      cur = cur.parent;
    }
    return Array.from(seen).sort();
  };
  defineIfMissing("defined?", (sym: any) => {
    const name = sym instanceof LSymbol ? (sym as any).name : String(sym);
    return (env as any).get(name, { throwError: false }) !== undefined;
  });
  const aproposImpl = (pat: any) => {
    const needle = pat instanceof LSymbol ? (pat as any).name : String(pat ?? "");
    const re = pat instanceof RegExp ? pat : null;
    const match = (n: string) => re ? re.test(n) : n.includes(needle);
    return toSchemeList(collectEnvNames().filter(match).map((n) => new LSymbol(n)));
  };
  defineIfMissing("apropos",      aproposImpl);
  defineIfMissing("apropos-list", aproposImpl);

  // ── Misc Racket ────────────────────────────────────────────
  defineIfMissing("current-seconds",      () => Math.floor(Date.now() / 1000));
  defineIfMissing("current-milliseconds", () => Date.now());
  defineIfMissing("current-inexact-milliseconds", () => performance.now());
}

// Canonical names we claim coverage for. R = R7RS small base; S = SRFI-1;
// K = Racket racket/base/list/string/format. Continuations, ports, bytevectors,
// and char predicates are intentionally omitted — they'd be misleading
// "coverage" without real functionality.
const COVERAGE_CHECKLIST: string[] = [
  // R7RS § 6.1 equivalence
  "eq?", "eqv?", "equal?",
  // R7RS § 6.2 numbers
  "number?", "integer?", "exact?", "inexact?", "exact-integer?",
  "finite?", "infinite?", "nan?",
  "=", "<", ">", "<=", ">=",
  "zero?", "positive?", "negative?", "odd?", "even?",
  "max", "min", "+", "-", "*", "/",
  "abs", "quotient", "remainder", "modulo",
  "gcd", "lcm", "floor", "ceiling", "truncate", "round",
  "exp", "log", "sin", "cos", "tan", "asin", "acos", "atan",
  "sqrt", "expt",
  "exact", "inexact", "exact->inexact", "inexact->exact",
  "number->string", "string->number",
  // R7RS § 6.3 booleans
  "not", "boolean?", "boolean=?",
  // R7RS § 6.4 lists
  "pair?", "cons", "car", "cdr",
  "null?", "list?", "list", "length", "append", "reverse",
  "list-tail", "list-ref",
  "memq", "memv", "member",
  "assq", "assv", "assoc",
  // R7RS § 6.5 symbols
  "symbol?", "symbol=?", "symbol->string", "string->symbol",
  // R7RS § 6.7 strings
  "string?", "make-string", "string", "string-length", "string-ref",
  "string=?", "string-ci=?", "string<?", "string>?", "string<=?", "string>=?",
  "string-ci<?", "string-ci>?",
  "string-upcase", "string-downcase", "string-foldcase",
  "substring", "string-append", "string->list", "list->string", "string-copy",
  // R7RS § 6.10 control
  "procedure?", "apply", "map", "for-each",
  // R7RS § 6.11 error
  "error",
  // SRFI-1 (beyond R7RS list ops)
  "first", "second", "third", "fourth", "fifth", "last", "last-pair",
  "take", "drop", "iota",
  "any", "every", "count", "find",
  "filter", "filter-map", "remove", "partition",
  "fold", "fold-right", "reduce", "reduce-right", "append-map", "concatenate",
  "delete", "delete-duplicates",
  "zip", "take-while", "drop-while", "span", "break",
  "list-index", "length+", "list-tabulate", "cons*", "list*",
  "append-reverse", "alist-cons", "alist-copy",
  // Racket strings
  "string-split", "string-join", "string-trim",
  "string-trim-left", "string-trim-right", "string-trim-both",
  "string-contains", "string-contains?", "string-prefix?", "string-suffix?",
  "string-replace", "string-index", "non-empty-string?",
  // Racket regex + cross-dialect aliases
  "regexp", "regexp?", "regexp-match", "regexp-match-positions",
  "regexp-replace", "regexp-replace*", "regexp-quote", "regexp-split",
  "string-match", "match:substring",
  // Racket format
  "format", "printf", "~a", "~s", "~v", "displayln",
  // Racket list/sequence
  "range", "flatten", "index-of",
  "argmax", "argmin", "remove-duplicates", "group-by",
  "add1", "sub1", "sqr", "identity",
  // Sort (R7RS-large / SRFI-132 / Racket)
  "sort", "sort!", "list-sort",
  // Racket list aliases & gaps
  "empty?", "empty", "cons?", "andmap", "ormap", "findf", "assf",
  "make-list", "build-list", "take-right", "drop-right", "split-at",
  "shuffle", "add-between", "remf", "remf*",
  "rest", "sixth", "seventh", "eighth", "ninth", "tenth",
  "index-where", "indexes-of", "list-update", "list-set", "list-prefix?",
  "split-at-right", "takef", "dropf", "memf",
  "append*", "filter-not", "check-duplicates",
  "cartesian-product", "inclusive-range", "remove*",
  // Racket numbers (gaps)
  "pi", "random",
  "exact-floor", "exact-ceiling", "exact-round", "exact-truncate",
  "sgn", "sinh", "cosh", "tanh",
  "degrees->radians", "radians->degrees",
  "natural?", "positive-integer?", "negative-integer?",
  "real->decimal-string",
  // Racket strings & chars (gaps)
  "string-titlecase", "string-pad", "string-pad-right",
  "char-upcase", "char-downcase",
  "string-normalize-spaces", "build-string",
  // Racket hash
  "make-hash", "hash", "hash?", "hash-ref", "hash-set!", "hash-set",
  "hash-remove!", "hash-has-key?", "hash-keys", "hash-values", "hash-count",
  "hash-update!", "hash-update", "hash-map", "hash-for-each",
  "hash->list", "hash-empty?", "hash-clear!",
  "hash-copy", "hash-ref!", "hash-remove", "hash-union",
  "hasheq", "hasheqv", "make-hasheq", "make-hasheqv", "make-immutable-hash",
  // Racket boxes
  "box", "box?", "unbox", "set-box!",
  // Environment introspection
  "defined?", "apropos", "apropos-list",
  // Racket time
  "current-seconds", "current-milliseconds", "current-inexact-milliseconds",
];

function auditShimCoverage(env: any): { defined: number; missing: string[] } {
  const missing: string[] = [];
  let defined = 0;
  for (const name of COVERAGE_CHECKLIST) {
    const v = (env as any).get(name, { throwError: false });
    if (v === undefined) missing.push(name);
    else defined++;
  }
  return { defined, missing };
}



// ── host bridge ───────────────────────────────────────────────────
// Quoted alist literals like '((k . #t)) may carry #t/#f as LSymbol or as
// the string "#t"/"#f". Normalize to JS bool.
function unwrapSchemeBool(v: any): any {
  if (v === true || v === false) return v;
  if (v instanceof LSymbol) {
    const n = (v as any).name;
    if (n === "#t") return true;
    if (n === "#f") return false;
  }
  if (v === "#t") return true;
  if (v === "#f") return false;
  return v;
}

// Convert a Scheme alist ((kebab-key . val) …) into the JS object shape
// the underlying tool expects. Renames keys (kebab→snake), coerces numeric
// values, and normalizes booleans. Returns {} for non-Pair input.
function readOptions(
  value: any,
  keyMap: Record<string, string>,
  numericKeys?: Set<string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!(value instanceof Pair)) return out;
  let node: any = value;
  while (node instanceof Pair) {
    const entry = node.car;
    if (entry instanceof Pair && entry.car instanceof LSymbol) {
      const k = (entry.car as any).name;
      const tgt = keyMap[k];
      if (tgt !== undefined) {
        let v: any = entry.cdr;
        if (numericKeys && numericKeys.has(tgt)) v = Number(v);
        else v = unwrapSchemeBool(v);
        out[tgt] = v;
      }
    }
    node = node.cdr;
  }
  return out;
}

function resolveExecutor(ctx: AgentContext, name: string): ToolExecutor {
  const tool = ctx.agent.getTools().find((t) => t.name === name);
  if (!tool) throw new Error(`scheme bridge: tool '${name}' not registered`);
  return (args) => tool.execute(args);
}

function installBindings(
  env: any,
  bus: Bus,
  bash: ToolExecutor,
  readFile: ToolExecutor,
  writeFile: ToolExecutor,
  editFile: ToolExecutor | null,
  grep: ToolExecutor | null,
  glob: ToolExecutor | null,
): void {
  const runBash = async (command: string, timeoutSec?: number) => {
    const args: Record<string, unknown> = { command };
    if (typeof timeoutSec === "number") args.timeout = timeoutSec;
    const result = await bash(args);
    let content = typeof result.content === "string" ? result.content : String(result.content ?? "");
    // Undo bash.ts's "(no output)" sentinel so `(eq? out "")` works.
    if (content === "(no output)") content = "";
    return {
      exitCode: result.exitCode ?? (result.isError ? 1 : 0),
      stdout: content,
      stderr: result.isError ? content : "",
      success: !result.isError,
    };
  };
  env.set("bash", async (command: string, timeoutSec?: number) => {
    try {
      const r = await runBash(command, timeoutSec);
      return alist([
        ["exit-code", r.exitCode],
        ["stdout",    r.stdout],
        ["stderr",    r.stderr],
        ["success",   r.success],
      ]);
    } catch (e: any) {
      logErr("bash", e, { command, typeofCommand: typeof command });
      throw e;
    }
  });
  // Shortcut: return stdout as string. Use `bash` when you need exit-code/stderr.
  env.set("sh", async (command: string, timeoutSec?: number) => {
    try {
      const r = await runBash(command, timeoutSec);
      return r.stdout;
    } catch (e: any) {
      logErr("sh", e, { command });
      return "";
    }
  });
  env.set("sh-ok?", async (command: string, timeoutSec?: number) => {
    try {
      const r = await runBash(command, timeoutSec);
      return r.success;
    } catch {
      return false;
    }
  });

  env.set("read-file", async (filePath: string, offset?: any, limit?: any) => {
    const args: Record<string, unknown> = { path: filePath, bypass_cache: true };
    if (offset !== undefined && offset !== null) {
      const n = Number(offset);
      if (!isNaN(n)) args.offset = n;
    }
    if (limit !== undefined && limit !== null) {
      const n = Number(limit);
      if (!isNaN(n)) args.limit = n;
    }
    const result = await readFile(args);
    return result.isError ? false : result.content;
  });

  env.set("write-file", async (filePath: string, content: string) => {
    // Re-emit tool lifecycle events so the TUI shows diffs.
    const result = await withDisplay(
      bus, "write_file", "write", { path: filePath, content }, filePath,
      () => writeFile({ path: filePath, content }),
    );
    return result.isError ? result.content : true;
  });

  if (editFile) {
    env.set("edit-file", async (filePath: string, oldStr: string, newStr: string, replaceAll?: any) => {
      const toolArgs: Record<string, unknown> = { path: filePath, old_text: oldStr, new_text: newStr };
      if (unwrapSchemeBool(replaceAll) === true) toolArgs.replace_all = true;
      const result = await withDisplay(
        bus, "edit_file", "write", toolArgs, filePath,
        () => editFile(toolArgs),
      );
      return result.isError ? result.content : true;
    });
  }

  if (grep) {
    const GREP_KEYMAP = {
      "include":          "include",
      "case-insensitive": "case_insensitive",
      "context-before":   "context_before",
      "context-after":    "context_after",
      "limit":            "head_limit",
      "offset":           "offset",
    } as const;
    const GREP_NUMERIC = new Set([
      "context_before", "context_after", "head_limit", "offset",
    ]);

    // Ripgrep uses Rust/ERE regex, but models write BRE (the default flavor
    // of plain grep/sed) where \| \( \) \{ \} \+ \? are metacharacters.
    // Translate BRE escapes to their ERE equivalents so the model's intent is
    // honored without dialect-switching overhead.
    const normalizePattern = (pat: string): string => {
      return pat
        .replace(/\\\|/g, "|")
        .replace(/\\\(/g, "(").replace(/\\\)/g, ")")
        .replace(/\\\{/g, "{").replace(/\\\}/g, "}")
        .replace(/\\\+/g, "+").replace(/\\\?/g, "?");
    };

    env.set("%grep", async (pattern: string, p?: string, third?: any) => {
      const args: Record<string, unknown> = { pattern: normalizePattern(String(pattern ?? "")), output_mode: "content" };
      if (typeof p === "string") args.path = p;
      if (third instanceof Pair) {
        Object.assign(args, readOptions(third, GREP_KEYMAP, GREP_NUMERIC));
      } else if (third !== undefined && third !== null) {
        // Back-compat: third positional arg as numeric limit.
        const n = Number(third);
        if (!isNaN(n)) args.head_limit = n;
      }
      const result = await grep(args);
      if (result.isError) return nil;
      if (result.content === "No matches found.") return nil;
      const rows: unknown[] = [];
      for (const line of stripPagination(result.content)) {
        const parsed = parseGrepLine(line, typeof p === "string" ? p : undefined);
        if (parsed) rows.push(parsed);
      }
      return toSchemeList(rows);
    });

    env.set("%grep-files", async (pattern: string, p?: string, opts?: any) => {
      const args: Record<string, unknown> = { pattern: normalizePattern(String(pattern ?? "")), output_mode: "files_with_matches" };
      if (typeof p === "string") args.path = p;
      if (opts instanceof Pair) Object.assign(args, readOptions(opts, GREP_KEYMAP, GREP_NUMERIC));
      const result = await grep(args);
      if (result.isError || result.content === "No matches found.") return nil;
      return toSchemeList(stripPagination(result.content));
    });
  }

  if (glob) {
    // Strip leading "./" so glob paths match grep's — otherwise eq? on the
    // file field fails across the two.
    env.set("glob", async (pattern: string, p?: string) => {
      const args: Record<string, unknown> = { pattern };
      if (typeof p === "string") args.path = p;
      const result = await glob(args);
      if (result.isError || result.content === "No files matched.") return nil;
      const paths = stripPagination(result.content).map((l) =>
        l.startsWith("./") ? l.slice(2) : l,
      );
      return toSchemeList(paths);
    });
  }

  // Shell-result accessors — JS-side so they're never missing.
  env.set("exit-code-of", (r: unknown) => lookup(r, "exit-code"));
  env.set("stdout-of",    (r: unknown) => lookup(r, "stdout"));
  env.set("stderr-of",    (r: unknown) => lookup(r, "stderr"));
  env.set("success?",     (r: unknown) => lookup(r, "success") === true);

  // R7RS / string helpers LIPS doesn't ship.
  env.set("string-length", (s: unknown) => (typeof s === "string" ? s.length : 0));
  const stringContains = (s: unknown, needle: unknown) =>
    typeof s === "string" && typeof needle === "string" && s.includes(needle);
  env.set("string-contains?", stringContains);
  // Racket spells it without the `?`. Bind both so the model isn't punished
  // for guessing dialect.
  env.set("string-contains", stringContains);
  env.set("string-append", (...parts: unknown[]) =>
    parts.map((p) => (p === undefined || p === null ? "" : String(p))).join(""));
  env.set("number->string", (n: unknown) => String(n));
  env.set("string->number", (s: unknown) => {
    if (typeof s !== "string") return false;
    const n = Number(s);
    return Number.isNaN(n) ? false : n;
  });
  env.set("symbol->string", (sym: any) => (sym && sym.name) ? sym.name : String(sym));
  // LIPS doesn't ship max/min — useful enough that not having them breaks
  // common idioms like `(max 1 (- n 5))` for line-bound clamping.
  env.set("max", (...args: any[]) => args.reduce((a, b) => (Number(a) >= Number(b) ? a : b)));
  env.set("min", (...args: any[]) => args.reduce((a, b) => (Number(a) <= Number(b) ? a : b)));
  installStdShims(env);
  // Global string substitution — LIPS' built-in `replace` with a string
  // pattern only replaces the first match (it calls JS String.replace).
  // This binding replaces every occurrence, sed-style.
  env.set("string-replace", (oldStr: unknown, newStr: unknown, s: unknown) => {
    if (typeof s !== "string") return s;
    return s.split(String(oldStr ?? "")).join(String(newStr ?? ""));
  });

  // LIPS' tokenizer doesn't recognize R7RS `#t`/`#f` — they parse as
  // unbound symbols. Bind them so the natural R7RS reflex works.
  env.set("#t", true);
  env.set("#f", false);
  env.set("lines", (s: unknown) => {
    if (typeof s !== "string" || s.length === 0) return nil;
    const parts = s.split("\n");
    if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
    let tail: any = nil;
    for (let i = parts.length - 1; i >= 0; i--) tail = new Pair(parts[i], tail);
    return tail;
  });
}

// ── tool registration ─────────────────────────────────────────────
const DESCRIPTION = [
  "Evaluate a Scheme expression (R7RS-compatible).",
  "",
  "A Scheme runtime with host bindings to the shell, filesystem, search,",
  "and file editing. Each submission is parsed and evaluated against an",
  "environment that persists across calls within the session — `define`s",
  "in one submission are available in the next.",
  "",
  "Productive patterns:",
  "  - Host bindings (`grep`, `glob`, `read-file`, …) return Scheme data,",
  "    so the output of one can feed into the next without re-parsing.",
  "    `(map proc (grep \"pat\" \"src/\"))` is the natural shape.",
  "  - Read-only calls (`read-file`, `grep`, `glob`, `sh` for queries) have",
  "    no side effects and can be batched in one submission — bind several",
  "    with `let`/`define` and assemble the answer locally, instead of",
  "    issuing each as a separate tool round. Side-effecting calls",
  "    (`write-file`, `edit-file`, mutating `bash`) are clearer one step",
  "    at a time so you can react to each result.",
  "  - The env persists across submissions, so binding intermediate",
  "    results once (e.g. `(define files (glob …))`) avoids recomputing",
  "    them in later calls.",
  "  - `(bash …)` calls a real shell — natural for shell-shaped work",
  "    (tests, builds, git, system commands). Three variants of the shell",
  "    binding return different shapes:",
  "      `(sh \"cmd\")`     → just the output as a string. Fits \"run this,",
  "                          show me the result\" without unwrapping.",
  "      `(sh-ok? \"cmd\")` → just a boolean. Fits `(if (sh-ok? \"…\") …)`",
  "                          branches and existence checks.",
  "      `(bash \"cmd\")`   → full alist when you need stdout *and* exit",
  "                          code *and* stderr separately (e.g. capture",
  "                          stderr while letting stdout flow on).",
  "    For file content work, the host bindings (`grep`, `read-file`,",
  "    `glob`) avoid shell-quoting entirely and return structured data.",
  "  - `scheme-define` saves a procedure to disk so it auto-loads next",
  "    session — useful when you've worked out something reusable.",
  "",
  "Host bindings:",
  "  (bash cmd [timeout-sec])               → alist ((exit-code . N) (stdout . S) (stderr . S) (success . #t/#f))",
  "    cmd is run via `bash -c`. Pipes/redirects/$VARS/&&/||/here-docs work",
  "    inside the string; there's no piping between separate bash calls.",
  "  (sh cmd [timeout-sec])                 → stdout string (stderr text on failure)",
  "  (sh-ok? cmd [timeout-sec])             → #t if exit code 0, else #f",
  "  (read-file path)                       → string, or #f on error",
  "  (read-file path offset)                → from line offset (1-indexed) to end",
  "  (read-file path offset limit)          → offset + N lines",
  "  (write-file path content)              → #t on success, error string on failure",
  "  (edit-file path old new)               → #t on success, error string on failure",
  "  (edit-file path old new #t)            → replace every occurrence (not just one)",
  "  (grep pattern [path] [limit|opts])     → list of ((file . S) (line . N) (text . S))",
  "  (grep-files pattern [path] [opts])     → list of file paths",
  "    Patterns are ripgrep regex (Rust). Both POSIX BRE escapes (`\\|`,",
  "    `\\(`, `\\)`, `\\{`, `\\}`, `\\+`, `\\?`) and bare ERE-style metacharacters",
  "    (`|`, `(`, `)`, `{`, `}`, `+`, `?`) work — the bridge translates BRE to",
  "    ERE before invoking ripgrep. `.` is any char, `\\b` is a word boundary.",
  "    opts: ((include . \"*.ts\")           ; filename glob filter",
  "           (case-insensitive . #t)",
  "           (context-before . N) (context-after . N)  ; grep only",
  "           (limit . N) (offset . N))",
  "    The opts alist is auto-quoted, so `((k . v) …)` and `'((k . v) …)` both work.",
  "  (glob pattern [base-dir])              → list of file paths (mtime-sorted)",
  "Accessors on bash result: (stdout-of r) (stderr-of r) (exit-code-of r) (success? r)",
  "Strings: (string-length s) (string-contains? s n) (string-append . parts)",
  "         (string-replace old new s) (number->string n) (string->number s)",
  "         (lines s) (split sep s) (replace pat repl s)  (max …) (min …)",
  "",
  "Standard Scheme: if cond when unless begin and or not  |  let let* define set! lambda",
  "  map filter fold reduce for-each  |  eq? null? pair? number? string? empty?",
  "  list car cdr cons length append reverse assoc  |  define-macro",
  "",
  "Dialect notes:",
  "  - R7RS truthy semantics: anything that isn't `#f` is true. `(if str …)`,",
  "    `(if 0 …)`, `(if '() …)` all take the then-branch.",
  "  - `#t`/`#f` work as expected. `equal?`, `eq?`, `eqv?`, `string=?` all work.",
  "  - SRFI-1: `member`, `assq`/`assv`/`assoc`, `delete-duplicates`, `first`",
  "    through `fifth`, `last`, `take`, `drop`, `iota`, `any`, `every`, `count`,",
  "    `find`, `filter-map`, `append-map`, `concatenate`, `partition`, `remove`,",
  "    `delete`, `zip`, `take-while`, `drop-while`, `fold-right` are all bound.",
  "  - R7RS extras: `string-upcase`/`-downcase`, `string-split`/`-join`,",
  "    `zero?`/`positive?`/`negative?`/`odd?`/`even?`, `modulo`, `quotient`,",
  "    `remainder`, `expt`, `ceiling`, `error`, `newline`, `displayln`.",
  "",
  "  (scheme-define name (args …) \"docstring\" body …)",
  "    Defines like `define`, and also saves to",
  "    ~/.agent-sh/scheme-define/{name}.scm so it auto-loads next session.",
  "",
  "Default timeout 15s; pass timeout_ms to override (max 60s).",
].join("\n");

// Scheme prelude — R7RS forms LIPS doesn't ship. Evaluated after the JS
// bindings (#t/#f, null?, etc.) are in place. `define-macro` is LIPS' own
// macro form (defmacro-style); used here because `define-syntax` isn't
// available either.
const PRELUDE = `
(define-macro (cond . clauses)
  (if (null? clauses)
      #f
      (let ((c (car clauses)) (rest (cdr clauses)))
        (if (eq? (car c) 'else)
            (cons 'begin (cdr c))
            (list 'if (car c)
                  (cons 'begin (cdr c))
                  (cons 'cond rest))))))

(define-macro (when test . body)
  (list 'if test (cons 'begin body) #f))

(define-macro (unless test . body)
  (list 'if test #f (cons 'begin body)))

;; R7RS shims for things models commonly reach for that LIPS doesn't ship.
(define (newline) (display "\n"))
(define assq assoc)

;; grep / grep-files: auto-quote alist-literal opts so callers can write
;; either ((k . v) ...) or '((k . v) ...). Without this, the bare form is
;; read as a function call on (k . v) and errors with an unbound-variable
;; message that doesn't point at the cause.
(define (%alist-literal? x)
  (and (pair? x) (pair? (car x)) (symbol? (car (car x)))))

(define-macro (grep . args)
  (if (and (>= (length args) 3) (%alist-literal? (car (cdr (cdr args)))))
      (cons '%grep
            (cons (car args)
                  (cons (car (cdr args))
                        (cons (list 'quote (car (cdr (cdr args))))
                              (cdr (cdr (cdr args)))))))
      (cons '%grep args)))

(define-macro (grep-files . args)
  (if (and (>= (length args) 3) (%alist-literal? (car (cdr (cdr args)))))
      (cons '%grep-files
            (cons (car args)
                  (cons (car (cdr args))
                        (cons (list 'quote (car (cdr (cdr args))))
                              (cdr (cdr (cdr args)))))))
      (cons '%grep-files args)))
`;

export default function activate(ctx: AgentContext): void {
  const env = (lips as any).env.inherit("scheme-ext");
  installFixedDefine(env);
  installLenientIf(env);
  const defineRegistry: DefineRegistry = new Map();
  const defineLoading = { active: false };
  // Forward decl: assigned after baseInstruction is computed below.
  let onDefineChange: () => void = () => {};
  installSchemeDefine(env, defineRegistry, defineLoading, () => onDefineChange());
  const schemeOnly = Boolean((getSettings() as any).scheme?.only);

  // Resolve executors before any unregister, so the bridge keeps working.
  const bash = resolveExecutor(ctx, "bash");
  const readFile = resolveExecutor(ctx, "read_file");
  const writeFile = resolveExecutor(ctx, "write_file");
  let editFile: ToolExecutor | null = null;
  let grep: ToolExecutor | null = null;
  let glob: ToolExecutor | null = null;
  try { editFile = resolveExecutor(ctx, "edit_file"); } catch { /* optional */ }
  try { grep = resolveExecutor(ctx, "grep"); } catch { /* optional */ }
  try { glob = resolveExecutor(ctx, "glob"); } catch { /* optional */ }
  installBindings(env, ctx.bus, bash, readFile, writeFile, editFile, grep, glob);

  // Fire-and-forget: exec is async but macros register in <1ms, well before
  // any user call. Load persisted defines, then audit shim coverage.
  void (lips as any).exec(PRELUDE, env)
    .then(() => loadPersistedDefines(env, defineRegistry, defineLoading))
    .then(() => {
      const audit = auditShimCoverage(env);
      if (audit.missing.length > 0) {
        logErr("shim-audit", new Error("missing canonical names"), {
          defined: audit.defined,
          total: audit.defined + audit.missing.length,
          missing: audit.missing,
        });
      }
    })
    .catch((e: any) => logErr("prelude", e));

  if (schemeOnly) {
    for (const name of HIDDEN_IN_SCHEME_ONLY) {
      try { ctx.agent.unregisterTool(name); } catch { /* not registered — fine */ }
    }
    ctx.bus.onPipe("agent:core-tools:collect", (ev) => ({
      ...ev,
      names: [...ev.names, "scheme_eval"],
    }));
  }

  ctx.agent.registerTool({
    name: "scheme_eval",
    displayName: "scheme",
    description: DESCRIPTION,
    maxResultBytes: 128 * 1024,
    input_schema: {
      type: "object",
      properties: {
        source: {
          type: "string",
          description: "Scheme source. One or more top-level forms; value of the last is returned.",
        },
        timeout_ms: {
          type: "number",
          description: "Optional timeout override (default 15000ms, max 60000).",
        },
      },
      required: ["source"],
    },
    getDisplayInfo: () => ({ kind: "execute", icon: "λ", sourceLanguage: "scheme" }),
    formatResult: (args, result) => {
      // Output is usually a long alist or file dump — the LLM still gets full
      // content via tool_result, but the TUI body shows the SOURCE so Ctrl+O
      // reveals what ran rather than what came back. scheme-render.ts (if
      // loaded) honors this; ashi's default renderer currently ignores
      // body.kind === "lines", which is fine — summary still carries the gist.
      const sourceLines = String(args.source ?? "").split("\n");
      if (!result.isError) {
        return {
          summary: summarizeResult(result.content, false),
          body: { kind: "lines", lines: sourceLines, maxLines: 30 },
        };
      }
      const lines = [...sourceLines, "", "✗ " + result.content];
      return {
        summary: summarizeResult(result.content, true),
        body: { kind: "lines", lines, maxLines: 30 },
      };
    },
    async execute(args) {
      const source = String(args.source ?? "");
      const timeoutMs = Math.min(Number(args.timeout_ms) || 15000, 60000);
      if (!source.trim()) {
        return { content: "scheme_eval: empty source", exitCode: 1, isError: true };
      }
      const result = await evaluate(env, source, timeoutMs);
      if (!result.ok) {
        return { content: `scheme error: ${result.error}`, exitCode: 1, isError: true };
      }
      const out = result.value.length > MAX_OUTPUT_LEN
        ? result.value.slice(0, MAX_OUTPUT_LEN) + `\n... [truncated ${result.value.length - MAX_OUTPUT_LEN} chars]`
        : result.value;
      return { content: out, exitCode: 0, isError: false };
    },
  });

  // schemeOnly: registerInstruction carries the full tool surface since
  // deferred-lookup mode strips tool descriptions from the system prompt.
  // coreTools puts scheme_eval's schema in the API tool list already; we
  // add behavioral framing here — specifically the context-preservation
  // nudge that would be lost in the long tool description.
  const baseInstruction = schemeOnly
    ? [
        "# Scheme runtime",
        "scheme_eval is your only tool; see its description for the API.",
        "",
        "## Context preservation",
        "Each tool round-trip permanently consumes context. Prefer composing",
        "multi-step operations into a single scheme_eval call so intermediate",
        "results stay in the Scheme heap instead of the conversation. Example:",
        "  (let ((files (glob \"src/**/*.ts\"))",
        "         (matches (grep \"TODO\" \"src/\")))",
        "    (filter (lambda (f) (member f (map (lambda (m) (cdr (assoc 'file m))) matches)))",
        "            files))",
        "This does glob + grep + filter in one round-trip. Use `define` to",
        "cache results across calls: `(define files (glob …))` once, reuse later.",
      ].join("\n")
    : [
        "# Scheme runtime",
        "scheme_eval evaluates Scheme with host bindings to bash, read-file, grep, glob, etc.",
        "See its description for the full API.",
        "",
        "## When to reach for scheme_eval",
        "The direct tools (grep, read_file, bash, etc.) are the right default for",
        "single operations. scheme_eval becomes valuable when you'd chain 2+ read-only",
        "tool calls that don't need inspection between steps — composing them inside",
        "Scheme keeps intermediate results in the Scheme heap instead of the",
        "conversation, saving context. Example:",
        "  (let ((matches (grep \"pattern\" \"src/\")))",
        "    (map (lambda (m) (list (cdr (assoc 'file m))",
        "                           (read-file (cdr (assoc 'file m)) (cdr (assoc 'line m)) 3)))",
        "         (take matches 5)))",
        "does grep + read-file × 5 in one round-trip. `define` caches across",
        "calls: `(define files (glob …))` once, reuse in later submissions.",
      ].join("\n");
  // Re-register when the scheme-define registry changes so the index stays
  // current within a session.
  onDefineChange = () => {
    const index = formatDefineIndex(defineRegistry);
    const text = index
      ? baseInstruction +
        "\n\n## Persistent procedures (from ~/.agent-sh/scheme-define/)\n" +
        index
      : baseInstruction;
    ctx.agent.registerInstruction("scheme", text);
  };
  onDefineChange();
}
