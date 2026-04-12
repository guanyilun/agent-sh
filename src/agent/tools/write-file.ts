import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ToolDefinition } from "../types.js";
import { computeDiff } from "../../utils/diff.js";

export function createWriteFileTool(getCwd: () => string): ToolDefinition {
  return {
    name: "write_file",
    description:
      "Create a new file or completely overwrite an existing one. Creates parent directories if needed. " +
      "ALWAYS prefer edit_file for modifying existing files — only use write_file for new files or complete rewrites.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute or relative file path",
        },
        content: {
          type: "string",
          description: "File content to write",
        },
      },
      required: ["path", "content"],
    },

    showOutput: true,
    modifiesFiles: true,
    requiresPermission: true,

    getDisplayInfo: (args) => ({
      kind: "write",
      locations: [{ path: args.path as string }],
    }),

    async execute(args, onChunk) {
      const filePath = args.path as string;
      const content = args.content as string;
      const absPath = path.resolve(getCwd(), filePath);

      try {
        let oldContent: string | null = null;
        try {
          oldContent = await fs.readFile(absPath, "utf-8");
        } catch {
          // New file
        }

        await fs.mkdir(path.dirname(absPath), { recursive: true });
        await fs.writeFile(absPath, content);

        // Compute and stream diff for display
        const diff = computeDiff(oldContent, content);
        if (onChunk && diff.hunks.length > 0) {
          for (const hunk of diff.hunks) {
            for (const line of hunk.lines) {
              if (line.type === "added") onChunk(`+${line.text}\n`);
              else if (line.type === "removed") onChunk(`-${line.text}\n`);
              else onChunk(` ${line.text}\n`);
            }
          }
        }

        const stats = diff.isNewFile
          ? `+${diff.added}`
          : `+${diff.added} -${diff.removed}`;
        return {
          content: oldContent === null
            ? `Created ${absPath} (${stats})`
            : `Wrote ${absPath} (${stats})`,
          exitCode: 0,
          isError: false,
        };
      } catch (err) {
        const msg =
          err instanceof Error ? err.message : String(err);
        return { content: `Error: ${msg}`, exitCode: 1, isError: true };
      }
    },
  };
}
