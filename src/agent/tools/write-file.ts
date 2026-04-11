import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ToolDefinition } from "../types.js";

export function createWriteFileTool(getCwd: () => string): ToolDefinition {
  return {
    name: "write_file",
    description:
      "Create or overwrite a file with the given content. Creates parent directories if needed. Prefer edit_file for modifying existing files.",
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

    showOutput: false,
    modifiesFiles: true,
    requiresPermission: true,

    getDisplayInfo: (args) => ({
      kind: "write",
      locations: [{ path: args.path as string }],
    }),

    async execute(args) {
      const filePath = args.path as string;
      const content = args.content as string;
      const absPath = path.resolve(getCwd(), filePath);

      try {
        const exists = await fs
          .access(absPath)
          .then(() => true)
          .catch(() => false);

        await fs.mkdir(path.dirname(absPath), { recursive: true });
        await fs.writeFile(absPath, content);

        return {
          content: exists
            ? `Wrote ${absPath}`
            : `Created ${absPath}`,
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
