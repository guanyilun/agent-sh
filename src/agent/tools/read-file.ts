import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ToolDefinition } from "../types.js";

export function createReadFileTool(getCwd: () => string): ToolDefinition {
  return {
    name: "read_file",
    description:
      "Read a file's contents with line numbers. Optionally specify offset and limit for large files.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute or relative file path",
        },
        offset: {
          type: "number",
          description: "Starting line number (1-indexed)",
        },
        limit: {
          type: "number",
          description: "Max lines to read",
        },
      },
      required: ["path"],
    },

    showOutput: false,

    getDisplayInfo: (args) => ({
      kind: "read",
      locations: [{ path: args.path as string }],
    }),

    async execute(args) {
      const filePath = args.path as string;
      const absPath = path.resolve(getCwd(), filePath);

      try {
        const content = await fs.readFile(absPath, "utf-8");
        const lines = content.split("\n");

        const start = ((args.offset as number) ?? 1) - 1; // 1-indexed → 0-indexed
        const end = args.limit ? start + (args.limit as number) : lines.length;
        const slice = lines.slice(start, end);

        // Add line numbers (1-indexed)
        const numbered = slice
          .map((line, i) => `${start + i + 1}\t${line}`)
          .join("\n");

        const truncated = end < lines.length;
        const suffix = truncated
          ? `\n[${lines.length - end} more lines, use offset=${end + 1} to continue]`
          : "";

        return { content: numbered + suffix, exitCode: 0, isError: false };
      } catch (err) {
        const msg =
          err instanceof Error ? err.message : String(err);
        return { content: `Error: ${msg}`, exitCode: 1, isError: true };
      }
    },
  };
}
