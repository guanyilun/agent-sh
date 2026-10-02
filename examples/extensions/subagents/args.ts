/**
 * Declared workflow arguments: `export const args = { target: { default: "src", help: "what to review" }, rounds: 3 }`.
 * A bare value is the default; its type (string, number, boolean) is the argument's type.
 */
export type ArgsSpec = Record<string, unknown>;

interface Field {
  name: string;
  type: "string" | "number" | "boolean";
  default?: unknown;
  help?: string;
  required: boolean;
}

export class ArgsError extends Error {}

function fields(spec: ArgsSpec): Field[] {
  return Object.entries(spec).map(([name, v]) => {
    const o = v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : { default: v };
    const type = (o.type as Field["type"]) ?? (typeof o.default === "number" ? "number" : typeof o.default === "boolean" ? "boolean" : "string");
    return { name, type, default: o.default, help: o.help as string | undefined, required: o.required === true && o.default === undefined };
  });
}

const flagName = (name: string) => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
const squash = (s: string) => s.replace(/-/g, "").toLowerCase();

/** Parses CLI-style tokens against the spec: --name value, --name=value, --flag / --no-flag, positional text. */
export function parseArgs(spec: ArgsSpec, tokens: string[]): Record<string, unknown> {
  const fs = fields(spec);
  const out: Record<string, unknown> = {};
  const positional: string[] = [];
  const find = (flag: string) => fs.find((f) => squash(f.name) === squash(flag));
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (!t.startsWith("--") || t === "--") { if (t !== "--") positional.push(t); continue; }
    let [flag, value] = t.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
    let f = find(flag);
    if (!f && flag.startsWith("no-") && find(flag.slice(3))?.type === "boolean") { f = find(flag.slice(3)); value = "false"; }
    if (!f) throw new ArgsError(`unknown argument --${flag}`);
    if (f.type === "boolean") {
      out[f.name] = value === undefined ? true : !/^(false|0|no)$/i.test(value);
      continue;
    }
    if (value === undefined) {
      value = tokens[++i];
      if (value === undefined) throw new ArgsError(`--${flagName(f.name)} needs a value`);
    }
    out[f.name] = convert(f, value);
  }
  if (positional.length) {
    const f = fs.find((x) => x.type === "string" && !(x.name in out));
    if (!f) throw new ArgsError(`unexpected argument "${positional.join(" ")}"`);
    out[f.name] = positional.join(" ");
  }
  // In declaration order, so printed args read like the file.
  const ordered: Record<string, unknown> = {};
  for (const f of fs) {
    if (!(f.name in out) && f.required) throw new ArgsError(`--${flagName(f.name)} is required`);
    ordered[f.name] = f.name in out ? out[f.name] : f.default;
  }
  return ordered;
}

function convert(f: Field, value: string): unknown {
  if (f.type !== "number") return value;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new ArgsError(`--${flagName(f.name)} must be a number, got "${value}"`);
  return n;
}

export function helpText(file: string, spec: ArgsSpec | undefined, description?: string): string {
  const fs = fields(spec ?? {});
  const meta = (f: Field) => (f.type === "boolean" ? "" : ` <${f.type === "number" ? "number" : "text"}>`);
  const usage = fs.map((f) => (f.required ? `--${flagName(f.name)}${meta(f)}` : `[--${flagName(f.name)}${meta(f)}]`)).join(" ");
  const lines = [`Usage: agent-sh run ${file}${usage ? ` ${usage}` : " [args...]"}`];
  if (description) lines.push("", description);
  if (fs.length) {
    const left = fs.map((f) => `--${flagName(f.name)}${meta(f)}`);
    const width = Math.max(...left.map((l) => l.length)) + 2;
    lines.push("", "Arguments:");
    fs.forEach((f, i) => {
      const notes = [f.help, f.required ? "required" : f.default !== undefined ? `default: ${JSON.stringify(f.default)}` : ""].filter(Boolean);
      lines.push(`  ${left[i]!.padEnd(width)}${notes.join("; ")}`);
    });
  }
  return lines.join("\n");
}

/** Splits free text like a shell would (quotes group words), for arguments given as one string. */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) out.push(m[1] ?? m[2] ?? m[3]!);
  return out;
}
