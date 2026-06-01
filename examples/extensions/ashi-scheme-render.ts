import type { AgentContext } from "agent-sh/types";
import type { RenderModel, Segment, ToolDisplay } from "@guanyilun/ashi/render";

interface SchemeInit { source: string }

function parseRaw(raw: unknown): Record<string, unknown> {
  if (typeof raw === "string") {
    try { return JSON.parse(raw) as Record<string, unknown>; } catch { return {}; }
  }
  if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  return {};
}

function source(rawInput: unknown): string {
  const r = parseRaw(rawInput);
  return typeof r.source === "string" ? r.source : "";
}

function compact(s: string, max = 80): string {
  const c = s.replace(/\s+/g, " ").trim();
  return c.length > max ? c.slice(0, max - 1) + "…" : c;
}

const model: RenderModel<SchemeInit> = {
  initial: ({ rawInput }) => ({ source: source(rawInput) }),
  view: (s, env): ToolDisplay => {
    const failed = !!s.status && s.status.exitCode !== 0 && s.status.exitCode !== null;
    const title: Segment[] = [
      { text: "scheme ", style: { bold: true, color: "toolTitle" } },
      { text: env.expanded ? s.source : compact(s.source), highlight: "scheme" },
    ];
    // A successful eval echoes no body (the source is in the title), so on expand
    // the result line is otherwise empty — move the completion summary there
    // (└ ✓ N lines) rather than stranding it on the wrapped title line.
    const summaryOnResult = env.expanded && env.finalized && !failed && !!s.status;
    return {
      titleIcon: "scheme",
      title,
      status: s.status,
      hideTitleStatus: summaryOnResult,
      body: failed
        ? { kind: "text", segments: [
            { text: `✗ ${s.output.trim()}`, style: { color: "error" } },
          ] }
        : summaryOnResult
          ? { kind: "text", segments: [
              { text: "✓", style: { color: "success" } },
              { text: ` ${s.status!.summary ?? "ok"}`, style: { color: "muted" } },
            ] }
          : { kind: "stream", text: s.output },
      expandable: true,
      defaultExpanded: failed,
    };
  },
};

export default function activate(ctx: AgentContext): void {
  for (const n of ["scheme", "scheme_eval"]) {
    ctx.define(`ashi:render-tool:${n}`, () => model);
  }
}
