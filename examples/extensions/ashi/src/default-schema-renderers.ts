// Default schema-style renderers shipped with ashi. Each model below could
// equally well live in an external extension — they use only the public
// "@guanyilun/ashi/render" surface, proving the schema covers ashi's own
// variety.

import type { ExtensionContext } from "agent-sh/types";
import type { RenderModel, Segment, ToolDisplay, TitleIcon, Color } from "./schema.js";

function parseRaw(raw: unknown): Record<string, unknown> {
  if (typeof raw === "string") {
    try { return JSON.parse(raw) as Record<string, unknown>; } catch { return {}; }
  }
  if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  return {};
}

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.length > 0 ? v : undefined;
const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

function compact(s: string, max = 80): string {
  const c = s.replace(/\s+/g, " ").trim();
  return c.length > max ? c.slice(0, max - 1) + "…" : c;
}

function relativize(fp: string): string {
  const home = process.env.HOME;
  const cwd = process.cwd();
  if (fp.startsWith(`${cwd}/`)) return fp.slice(cwd.length + 1);
  if (home && fp.startsWith(`${home}/`)) return `~/${fp.slice(home.length + 1)}`;
  return fp;
}

const nameSeg = (text: string): Segment => ({ text, style: { bold: true, color: "toolTitle" } });
const accentSeg = (text: string): Segment => ({ text, style: { color: "accent" } });
const mutedSeg = (text: string): Segment => ({ text, style: { color: "muted" } });
const warnSeg = (text: string): Segment => ({ text, style: { color: "warning" } });

// ---------------------------------------------------------------------------
// bash — full command toggle on Ctrl+O, syntax-highlighted, streaming output.

interface BashInit { command: string; timeout?: number }

const bashModel: RenderModel<BashInit> = {
  initial: ({ rawInput }) => {
    const r = parseRaw(rawInput);
    return { command: str(r.command) ?? "…", timeout: num(r.timeout) };
  },
  view: (s, env): ToolDisplay => {
    const title: Segment[] = [
      nameSeg("$ "),
      { text: env.expanded ? s.command : compact(s.command), highlight: "bash" },
    ];
    if (s.timeout !== undefined) title.push(mutedSeg(` (timeout ${s.timeout}s)`));
    return {
      title,
      status: s.status,
      body: { kind: "stream", text: s.output },
      expandable: true,
    };
  },
};

/** User-typed `!` shell commands. `▸ ` prefix mirrors the status-footer
 *  glyph for instant left-side recognition; right-aligned tag carries the
 *  full label so private vs public is unambiguous on scrollback. */
function makeUserBashModel(opts: { private: boolean }): RenderModel<BashInit> {
  const color: Color = opts.private ? "warning" : "bashMode";
  const prefixSeg: Segment = { text: "▸ ", style: { bold: true, color } };
  const tagText = opts.private ? "shell · private" : "shell";
  const tagSeg: Segment = { text: tagText, style: { color, dim: true } };
  return {
    initial: ({ rawInput }) => {
      const r = parseRaw(rawInput);
      return { command: str(r.command) ?? "…", timeout: num(r.timeout) };
    },
    view: (s, env): ToolDisplay => ({
      title: [prefixSeg, { text: env.expanded ? s.command : compact(s.command), highlight: "bash" }],
      titleRight: [tagSeg],
      status: s.status,
      body: { kind: "stream", text: s.output },
      expandable: true,
    }),
  };
}

// ---------------------------------------------------------------------------
// read — file path + optional offset:limit range.

interface ReadInit { path: string; range?: string }

const readModel: RenderModel<ReadInit> = {
  initial: ({ rawInput }) => {
    const r = parseRaw(rawInput);
    const path = str(r.file_path) ?? str(r.path);
    const offset = num(r.offset);
    const limit = num(r.limit);
    let range: string | undefined;
    if (offset !== undefined || limit !== undefined) {
      const from = offset ?? 1;
      const to = limit !== undefined ? from + limit - 1 : undefined;
      range = to ? `:${from}-${to}` : `:${from}`;
    }
    return { path: path ? relativize(path) : "…", range };
  },
  view: (s) => ({
    titleIcon: "read",
    title: [
      nameSeg("read "),
      accentSeg(s.path),
      ...(s.range ? [warnSeg(s.range)] : []),
    ],
    status: s.status,
    body: { kind: "stream", text: s.output },
    expandable: true,
  }),
};

// ---------------------------------------------------------------------------
// grep / glob / ls — pattern + scope.

interface GrepInit { pattern: string; scope: string; extras: string }

const grepModel: RenderModel<GrepInit> = {
  initial: ({ rawInput }) => {
    const r = parseRaw(rawInput);
    const glob = str(r.glob);
    const limit = num(r.limit);
    const extras = [glob ? `(${glob})` : "", limit !== undefined ? `limit ${limit}` : ""]
      .filter(Boolean).join(" ");
    return {
      pattern: str(r.pattern) ?? "…",
      scope: relativize(str(r.path) ?? "."),
      extras,
    };
  },
  view: (s) => ({
    titleIcon: "search",
    title: [
      nameSeg("grep "),
      accentSeg(`/${s.pattern}/`),
      { text: " " },
      mutedSeg(`in ${s.scope}`),
      ...(s.extras ? [mutedSeg(` ${s.extras}`)] : []),
    ],
    status: s.status,
    body: { kind: "stream", text: s.output },
    expandable: true,
  }),
};

interface PathPatternInit { pattern: string; scope: string }

const globModel: RenderModel<PathPatternInit> = {
  initial: ({ rawInput }) => {
    const r = parseRaw(rawInput);
    return { pattern: str(r.pattern) ?? "…", scope: relativize(str(r.path) ?? ".") };
  },
  view: (s) => ({
    titleIcon: "search",
    title: [nameSeg("glob "), accentSeg(s.pattern), { text: " " }, mutedSeg(`in ${s.scope}`)],
    status: s.status,
    body: { kind: "stream", text: s.output },
    expandable: true,
  }),
};

interface LsInit { path: string }

const lsModel: RenderModel<LsInit> = {
  initial: ({ rawInput }) => {
    const r = parseRaw(rawInput);
    return { path: relativize(str(r.path) ?? ".") };
  },
  view: (s) => ({
    titleIcon: "read",
    title: [nameSeg("ls "), accentSeg(s.path)],
    status: s.status,
    body: { kind: "stream", text: s.output },
    expandable: true,
  }),
};

// ---------------------------------------------------------------------------
// edit_file / write_file — path + framework-supplied diff body. The "Edited
// /path (+N -M)" streaming text is suppressed because the diff body already
// shows that information; per-line output reappears via expand on Ctrl+O.

interface EditInit { path: string; verb: string }

function editLikeModel(verb: string): RenderModel<EditInit> {
  return {
    initial: ({ rawInput }) => {
      const r = parseRaw(rawInput);
      const path = str(r.file_path) ?? str(r.path);
      return { path: path ? relativize(path) : "…", verb };
    },
    view: (s, env) => ({
      titleIcon: "edit",
      title: [nameSeg(`${s.verb} `), accentSeg(s.path)],
      status: s.status,
      // Collapsed-with-diff: diff only (the "Edited /path (+N -M)" stream line
      // restates the call line). Expanded-with-diff: diff + stream output.
      body: s.hasDiff
        ? (env.expanded
            ? { kind: "compound", parts: [{ kind: "diff" }, { kind: "stream", text: s.output }] }
            : { kind: "diff" })
        : { kind: "stream", text: s.output },
      expandable: true,
    }),
  };
}

// ---------------------------------------------------------------------------
// default — fallback for any tool without a specific renderer.

interface DefaultInit { title: string; detail?: string; icon: TitleIcon }

const defaultModel: RenderModel<DefaultInit> = {
  initial: ({ title, displayDetail }) => ({
    title,
    detail: displayDetail,
    icon: "generic",
  }),
  view: (s) => ({
    titleIcon: s.icon,
    title: [
      nameSeg(s.title),
      ...(s.detail ? [{ text: " " }, mutedSeg(s.detail)] : []),
    ],
    status: s.status,
    body: { kind: "stream", text: s.output },
    expandable: true,
  }),
};

// ---------------------------------------------------------------------------

export function registerDefaultSchemaRenderers(ctx: ExtensionContext): void {
  ctx.define("ashi:render-tool:bash", () => bashModel);
  ctx.define("ashi:render-tool:user_bash", () => makeUserBashModel({ private: false }));
  ctx.define("ashi:render-tool:user_bash_private", () => makeUserBashModel({ private: true }));
  ctx.define("ashi:render-tool:read_file", () => readModel);
  ctx.define("ashi:render-tool:read", () => readModel);
  ctx.define("ashi:render-tool:grep", () => grepModel);
  ctx.define("ashi:render-tool:glob", () => globModel);
  ctx.define("ashi:render-tool:ls", () => lsModel);
  ctx.define("ashi:render-tool:edit_file", () => editLikeModel("edit"));
  ctx.define("ashi:render-tool:edit", () => editLikeModel("edit"));
  ctx.define("ashi:render-tool:write_file", () => editLikeModel("write"));
  ctx.define("ashi:render-tool:write", () => editLikeModel("write"));
  ctx.define("ashi:render-tool:default", () => defaultModel);
}
