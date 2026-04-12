import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ToolDefinition } from "../types.js";

export function createLsTool(getCwd: () => string): ToolDefinition {
  return {
    name: "ls",
    description:
      "List files and directories in a given path.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Directory to list (default: cwd)",
        },
      },
    },

    showOutput: false,

    getDisplayInfo: (args) => ({
      kind: "read",
      locations: args.path
        ? [{ path: args.path as string }]
        : [],
    }),

    async execute(args) {
      const dirPath = (args.path as string) ?? ".";
      const absPath = path.resolve(getCwd(), dirPath);

      try {
        const entries = await fs.readdir(absPath, {
          withFileTypes: true,
        });

        const lines = entries.map((e) =>
          e.isDirectory() ? `${e.name}/` : e.name,
        );

        return {
          content: lines.join("\n") || "(empty directory)",
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
