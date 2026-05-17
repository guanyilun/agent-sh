import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "agent-sh/types";
import { theme } from "./theme.js";
import { GROUP_ICONS } from "./components.js";
import type { ToolCallArgs, ToolCallView } from "./hooks.js";

const TOOL_ICON: Record<string, string> = {
  read_file: GROUP_ICONS.read!,
  read: GROUP_ICONS.read!,
  ls: GROUP_ICONS.read!,
  grep: GROUP_ICONS.search!,
  glob: GROUP_ICONS.search!,
};

function iconPrefix(name: string): string {
  const icon = TOOL_ICON[name];
  return icon ? `${theme.fg("warning", icon)} ` : "";
}

interface StatusOpts { exitCode: number | null; elapsedMs: number; summary?: string }

function fmtElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(2)}s`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const totalSeconds = Math.floor(ms / 1000);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}m ${s}s`;
}

function parseRaw(raw: unknown): Record<string, unknown> {
  if (typeof raw === "string") {
    try { return JSON.parse(raw) as Record<string, unknown>; } catch { return {}; }
  }
  if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  return {};
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function relativize(fp: string): string {
  const home = process.env.HOME;
  const cwd = process.cwd();
  if (fp.startsWith(`${cwd}/`)) return fp.slice(cwd.length + 1);
  if (home && fp.startsWith(`${home}/`)) return `~/${fp.slice(home.length + 1)}`;
  return fp;
}

function statusSuffix(opts?: StatusOpts): string {
  if (!opts) return `  ${theme.fg("muted", "…")}`;
  const ok = opts.exitCode === null || opts.exitCode === 0;
  const mark = ok ? theme.fg("success", "✓") : theme.fg("error", "✗");
  const elapsed = opts.elapsedMs > 0 ? ` ${theme.fg("muted", fmtElapsed(opts.elapsedMs))}` : "";
  const sum = opts.summary ? ` ${theme.fg("muted", opts.summary)}` : "";
  return `  ${mark}${elapsed}${sum}`;
}

/** Renders a one-line tool call header from a label producer. The label is
 *  recomputed on setStatus so the trailing status mark updates in place. */
class LabeledCallLine extends Container implements ToolCallView {
  private line: Text;
  private status?: StatusOpts;
  constructor(private label: () => string) {
    super();
    this.line = new Text("", 1, 0);
    this.addChild(new Spacer(1));
    this.addChild(this.line);
    this.repaint();
  }
  setStatus(opts: StatusOpts): void {
    this.status = opts;
    this.repaint();
  }
  private repaint(): void {
    this.line.setText(`${this.label()}${statusSuffix(this.status)}`);
  }
}

const bold = (t: string): string => theme.bold(theme.fg("toolTitle", t));
const accent = (t: string): string => theme.fg("accent", t);
const muted = (t: string): string => theme.fg("muted", t);

function bashLabel(args: ToolCallArgs): string {
  const r = parseRaw(args.rawInput);
  const command = str(r.command) ?? "…";
  const timeout = num(r.timeout);
  const to = timeout ? muted(` (timeout ${timeout}s)`) : "";
  return `${bold("$")} ${accent(command)}${to}`;
}

function readLabel(args: ToolCallArgs): string {
  const r = parseRaw(args.rawInput);
  const path = str(r.file_path) ?? str(r.path);
  const offset = num(r.offset);
  const limit = num(r.limit);
  let range = "";
  if (offset !== undefined || limit !== undefined) {
    const from = offset ?? 1;
    const to = limit !== undefined ? from + limit - 1 : undefined;
    range = theme.fg("warning", to ? `:${from}-${to}` : `:${from}`);
  }
  return `${iconPrefix("read")}${bold("read")} ${accent(path ? relativize(path) : "…")}${range}`;
}

function grepLabel(args: ToolCallArgs): string {
  const r = parseRaw(args.rawInput);
  const pattern = str(r.pattern) ?? "…";
  const scope = relativize(str(r.path) ?? ".");
  const glob = str(r.glob);
  const limit = num(r.limit);
  const extras = [glob ? `(${glob})` : "", limit !== undefined ? `limit ${limit}` : ""].filter(Boolean).join(" ");
  const tail = extras ? muted(` ${extras}`) : "";
  return `${iconPrefix("grep")}${bold("grep")} ${accent(`/${pattern}/`)} ${muted(`in ${scope}`)}${tail}`;
}

function globLabel(args: ToolCallArgs): string {
  const r = parseRaw(args.rawInput);
  const pattern = str(r.pattern) ?? "…";
  const scope = relativize(str(r.path) ?? ".");
  return `${iconPrefix("glob")}${bold("glob")} ${accent(pattern)} ${muted(`in ${scope}`)}`;
}

function lsLabel(args: ToolCallArgs): string {
  const r = parseRaw(args.rawInput);
  const p = str(r.path) ?? ".";
  return `${iconPrefix("ls")}${bold("ls")} ${accent(relativize(p))}`;
}

function pathOnlyLabel(name: string, args: ToolCallArgs): string {
  const r = parseRaw(args.rawInput);
  const path = str(r.file_path) ?? str(r.path);
  return `${bold(name)} ${accent(path ? relativize(path) : "…")}`;
}

function genericLabel(args: ToolCallArgs): string {
  const detail = args.displayDetail ? ` ${muted(args.displayDetail)}` : "";
  return `${bold(args.title)}${detail}`;
}

export function registerDefaultToolRenderers(ctx: ExtensionContext): void {
  const define = (name: string, fn: (args: ToolCallArgs) => ToolCallView): void => {
    ctx.define(`ashi:render-tool-call:${name}`, fn);
  };

  define("bash", (args) => new LabeledCallLine(() => bashLabel(args)));

  define("read_file", (args) => new LabeledCallLine(() => readLabel(args)));
  define("read", (args) => new LabeledCallLine(() => readLabel(args)));

  define("grep", (args) => new LabeledCallLine(() => grepLabel(args)));
  define("glob", (args) => new LabeledCallLine(() => globLabel(args)));
  define("ls", (args) => new LabeledCallLine(() => lsLabel(args)));

  define("edit_file", (args) => new LabeledCallLine(() => pathOnlyLabel("edit", args)));
  define("edit", (args) => new LabeledCallLine(() => pathOnlyLabel("edit", args)));
  define("write_file", (args) => new LabeledCallLine(() => pathOnlyLabel("write", args)));
  define("write", (args) => new LabeledCallLine(() => pathOnlyLabel("write", args)));

  define("default", (args) => new LabeledCallLine(() => genericLabel(args)));
}
