import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ToolDefinition } from "../types.js";
import { computeDiff } from "../../utils/diff.js";

export function createEditFileTool(getCwd: () => string): ToolDefinition {
  return {
    name: "edit_file",
    description:
      "Edit a file by replacing an exact text match with new text. The old_text must appear exactly once in the file. Include enough context to make the match unique.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute or relative file path",
        },
        old_text: {
          type: "string",
          description: "Exact text to find (must appear exactly once)",
        },
        new_text: {
          type: "string",
          description: "Replacement text",
        },
      },
      required: ["path", "old_text", "new_text"],
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
      const oldText = args.old_text as string;
      const newText = args.new_text as string;
      const absPath = path.resolve(getCwd(), filePath);

      try {
        const content = await fs.readFile(absPath, "utf-8");

        // Normalize line endings for matching
        const normalized = content.replace(/\r\n/g, "\n");
        const normalizedOld = oldText.replace(/\r\n/g, "\n");

        const occurrences =
          normalized.split(normalizedOld).length - 1;
        if (occurrences === 0) {
          return {
            content: `Error: old_text not found in ${filePath}`,
            exitCode: 1,
            isError: true,
          };
        }
        if (occurrences > 1) {
          return {
            content: `Error: old_text found ${occurrences} times, must be unique. Add more surrounding context.`,
            exitCode: 1,
            isError: true,
          };
        }

        const normalizedNew = newText.replace(/\r\n/g, "\n");
        const newContent = normalized.replace(
          normalizedOld,
          normalizedNew,
        );

        // Restore original line endings
        const useCRLF = content.includes("\r\n");
        const finalContent = useCRLF
          ? newContent.replace(/\n/g, "\r\n")
          : newContent;

        await fs.writeFile(absPath, finalContent);

        // Compute and stream diff for display
        const diff = computeDiff(normalized, newContent);
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
          content: `Edited ${absPath} (${stats})`,
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
