/**
 * Interactive permission prompts extension.
 *
 * Gates the four built-in side-effect tools (bash, pwsh, write_file,
 * edit_file) via tool advisors. Without this extension, agent-sh runs in
 * yolo mode — tools execute without confirmation.
 *
 * Usage:
 *   agent-sh -e ./examples/extensions/interactive-prompts.ts
 *
 *   # Or copy to ~/.agent-sh/extensions/ for permanent use:
 *   cp examples/extensions/interactive-prompts.ts ~/.agent-sh/extensions/
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { renderDiff } from "agent-sh/utils/diff-renderer.js";
import { renderBoxFrame } from "agent-sh/utils/box-frame.js";
import { palette as p } from "agent-sh/utils/palette.js";
import { computeDiff, computeEditDiff, computeInputDiff, type DiffResult } from "agent-sh/utils/diff.js";
import type { ShellContext } from "agent-sh/types";
import type { ToolUI } from "agent-sh/agent/types.js";

const GATED_TOOLS = ["bash", "pwsh", "write_file", "edit_file"] as const;

export default function activate(ctx: ShellContext) {
  let autoApproveWrites = false;

  // Frame pre-execute diff previews as a permission prompt.
  ctx.advise("tui:render-diff", (_next, filePath: string, diff: DiffResult, width: number) => {
    const boxW = Math.min(84, width);
    const contentW = boxW - 4;
    const MAX_DISPLAY = 25;

    const stats = diff.isNewFile
      ? `(+${diff.added} lines)`
      : `(+${diff.added} / -${diff.removed})`;
    const title = diff.isNewFile
      ? `new: ${filePath}  ${stats}`
      : `${filePath}  ${stats}`;

    const diffLines = renderDiff(diff, {
      width: contentW,
      filePath,
      maxLines: MAX_DISPLAY,
      trueColor: true,
      mode: "unified",
    });
    const content = ["", ...diffLines.slice(1), ""];

    return renderBoxFrame(content, {
      width: boxW,
      style: "rounded",
      borderColor: p.warning,
      title,
      footer: [`  ${p.bold}[y] Apply  [n] Skip  [a] Don't ask again${p.reset}`],
    });
  });

  for (const name of GATED_TOOLS) {
    ctx.adviseTool(name, async (next, args, onChunk, toolCtx) => {
      const ui = toolCtx?.ui;
      if (!ui) return next(args, onChunk, toolCtx);

      const isFileWrite = name === "write_file" || name === "edit_file";
      let diffPreRendered = false;

      ctx.bus.emit("shell:stdout-show", {});
      try {
        if (isFileWrite) {
          if (autoApproveWrites) {
            // Skip prompt; tool's own post-execute diff renders as usual.
            return next(args, onChunk, toolCtx);
          }
          await renderPreviewDiff(ctx, name, args);
          diffPreRendered = true;

          const answer = await promptWrite(ui);
          if (answer === "reject") {
            return { content: "Permission denied by user.", exitCode: 1, isError: true };
          }
          if (answer === "approve_all") autoApproveWrites = true;
        } else {
          const answer = await promptCommand(ui, name, args);
          if (answer === "deny") {
            return { content: "Permission denied by user.", exitCode: 1, isError: true };
          }
        }
      } finally {
        ctx.bus.emit("shell:stdout-hide", {});
      }

      const result = await next(args, onChunk, toolCtx);
      if (diffPreRendered && result.display?.body?.kind === "diff") {
        // Strip the redundant post-execute diff body since we already showed it.
        return { ...result, display: { ...result.display, body: undefined } };
      }
      return result;
    });
  }
}

async function renderPreviewDiff(
  ctx: ShellContext,
  toolName: string,
  args: Record<string, unknown>,
): Promise<void> {
  const rawPath = args.path;
  if (typeof rawPath !== "string") return;
  const absPath = path.resolve(process.cwd(), rawPath);

  let diff: DiffResult | undefined;
  if (toolName === "edit_file" && typeof args.old_text === "string" && typeof args.new_text === "string") {
    const normalizedOld = (args.old_text as string).replace(/\r\n/g, "\n");
    const normalizedNew = (args.new_text as string).replace(/\r\n/g, "\n");
    try {
      const oldFileContent = await fs.readFile(absPath, "utf-8");
      diff = computeEditDiff(
        oldFileContent, normalizedOld, normalizedNew,
        args.replace_all === true,
      );
    } catch {
      diff = computeInputDiff(normalizedOld, normalizedNew);
    }
  } else if (toolName === "write_file" && typeof args.content === "string") {
    let oldContent: string | null = null;
    try { oldContent = await fs.readFile(absPath, "utf-8"); } catch { /* new file */ }
    diff = computeDiff(oldContent, args.content as string);
  }
  if (!diff || diff.isIdentical) return;

  const cwd = process.cwd();
  const home = process.env.HOME ?? "";
  let displayPath = absPath;
  if (absPath.startsWith(cwd + "/")) displayPath = absPath.slice(cwd.length + 1);
  else if (home && absPath.startsWith(home + "/")) displayPath = "~/" + absPath.slice(home.length + 1);

  ctx.call("tui:show-diff", displayPath, diff);
}

async function promptWrite(ui: ToolUI): Promise<"approve" | "approve_all" | "reject"> {
  return ui.custom<"approve" | "approve_all" | "reject">({
    render(width) {
      const boxW = Math.min(84, width);
      return renderBoxFrame([], {
        width: boxW,
        style: "rounded",
        borderColor: p.warning,
        footer: [`  ${p.bold}[y] Apply  [n] Skip  [a] Don't ask again${p.reset}`],
      });
    },
    handleInput(data, done) {
      const ch = data.toLowerCase();
      if (ch === "y") done("approve");
      else if (ch === "a") done("approve_all");
      else if (ch === "n" || ch === "\x1b") done("reject");
    },
  });
}

async function promptCommand(
  ui: ToolUI,
  toolName: string,
  args: Record<string, unknown>,
): Promise<"approve" | "deny"> {
  const command = typeof args.command === "string" ? args.command : "";
  const description = typeof args.description === "string" ? args.description : "";
  const title = description ? `${toolName}: ${description}` : toolName;
  const body = command
    ? `${p.bold}${title}${p.reset}\n${p.dim}${truncate(command, 200)}${p.reset}`
    : `${p.bold}${title}${p.reset}`;
  return ui.custom<"approve" | "deny">({
    render(width) {
      const boxW = Math.min(84, width);
      return renderBoxFrame(body.split("\n"), {
        width: boxW,
        style: "rounded",
        borderColor: p.warning,
        title: "Permission required",
        footer: [`  ${p.dim}[y]es / [n]o${p.reset}`],
      });
    },
    handleInput(data, done) {
      const ch = data.toLowerCase();
      if (ch === "y") done("approve");
      else if (ch === "n" || ch === "\x1b") done("deny");
    },
  });
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}
