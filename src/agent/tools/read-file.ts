import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ToolDefinition } from "../types.js";

/** Tracks the last-read state of a file for deduplication. */
export interface FileReadState {
  mtimeMs: number;
  offset: number;
  limit: number | undefined;
}

/** Shared cache — keyed by absolute path. */
export type FileReadCache = Map<string, FileReadState>;

export function createReadFileTool(
  getCwd: () => string,
  cache?: FileReadCache,
): ToolDefinition {
  return {
    name: "read_file",
    description:
      "Read a file's contents with line numbers. Use offset and limit for large files. " +
      "Always read a file before editing it. " +
      "If the file hasn't changed since last read, returns a stub to save context.",
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
      icon: "◆",
      locations: [{ path: args.path as string }],
    }),

    formatResult: (_args, result) => {
      if (result.isError) return {};
      if (result.content.startsWith("File unchanged")) return { summary: "cached" };
      const lines = result.content.split("\n").filter(l => !l.startsWith("["));
      return { summary: `${lines.length} lines` };
    },

    async execute(args) {
      const filePath = args.path as string;
      const absPath = path.resolve(getCwd(), filePath);
      const reqOffset = (args.offset as number) ?? 1;
      const reqLimit = args.limit as number | undefined;

      try {
        const stat = await fs.stat(absPath);

        // Deduplication: if the file hasn't changed and same range, return stub
        if (cache) {
          const prev = cache.get(absPath);
          if (
            prev &&
            prev.mtimeMs === stat.mtimeMs &&
            prev.offset === reqOffset &&
            prev.limit === reqLimit
          ) {
            return {
              content:
                "File unchanged since last read. The content from the earlier read_file result in this conversation is still current — refer to that instead of re-reading.",
              exitCode: 0,
              isError: false,
            };
          }
        }

        // Check file size before reading to avoid OOM on huge files
        const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2MB
        if (stat.size > MAX_FILE_SIZE && !args.offset && !args.limit) {
          const sizeMB = (stat.size / (1024 * 1024)).toFixed(1);
          return {
            content: `File is ${sizeMB}MB (${stat.size} bytes) — too large to read in full. Use offset and limit to read specific sections, e.g. offset=1 limit=200.`,
            exitCode: 1,
            isError: true,
          };
        }

        const content = await fs.readFile(absPath, "utf-8");
        const lines = content.split("\n");

        const start = reqOffset - 1; // 1-indexed → 0-indexed
        const end = reqLimit ? start + reqLimit : lines.length;
        const slice = lines.slice(start, end);

        // Add line numbers (1-indexed)
        const numbered = slice
          .map((line, i) => `${start + i + 1}\t${line}`)
          .join("\n");

        const truncated = end < lines.length;
        const suffix = truncated
          ? `\n[${lines.length - end} more lines, use offset=${end + 1} to continue]`
          : "";

        // Update cache on successful read
        if (cache) {
          cache.set(absPath, {
            mtimeMs: stat.mtimeMs,
            offset: reqOffset,
            limit: reqLimit,
          });
        }

        return { content: numbered + suffix, exitCode: 0, isError: false };
      } catch (err) {
        const msg =
          err instanceof Error ? err.message : String(err);
        return { content: `Error: ${msg}`, exitCode: 1, isError: true };
      }
    },
  };
}
