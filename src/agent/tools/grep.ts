import { executeCommand } from "../../executor.js";
import type { ToolDefinition } from "../types.js";

export function createGrepTool(getCwd: () => string): ToolDefinition {
  return {
    name: "grep",
    description:
      "Search file contents using ripgrep. ALWAYS use this instead of running grep/rg via bash. " +
      "Supports three output modes: " +
      "'files_with_matches' (default, returns file paths only — use this to find which files contain a pattern), " +
      "'content' (matching lines with optional context_before/context_after), and " +
      "'count' (match counts per file). " +
      "Use head_limit and offset for pagination.",
    input_schema: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "Regex pattern to search for",
        },
        path: {
          type: "string",
          description: "Directory or file to search (default: cwd)",
        },
        include: {
          type: "string",
          description:
            "Glob pattern for files to include (e.g., '*.ts')",
        },
        output_mode: {
          type: "string",
          enum: ["files_with_matches", "content", "count"],
          description:
            "Output mode: 'files_with_matches' (default, file paths only), " +
            "'content' (matching lines), 'count' (match counts per file)",
        },
        case_insensitive: {
          type: "boolean",
          description: "Case insensitive search (default: false)",
        },
        context_before: {
          type: "number",
          description: "Lines to show before each match (content mode only)",
        },
        context_after: {
          type: "number",
          description: "Lines to show after each match (content mode only)",
        },
        head_limit: {
          type: "number",
          description:
            "Max lines/entries to return (default: 200 for files_with_matches, 150 for content/count). Pass 0 for unlimited.",
        },
        offset: {
          type: "number",
          description:
            "Skip first N lines/entries before applying head_limit. Use with head_limit for pagination.",
        },
      },
      required: ["pattern"],
    },

    showOutput: false,

    getDisplayInfo: (args) => ({
      kind: "search",
      locations: args.path
        ? [{ path: args.path as string }]
        : [],
    }),

    async execute(args) {
      const pattern = args.pattern as string;
      const searchPath = (args.path as string) ?? ".";
      const include = args.include as string | undefined;
      const mode = (args.output_mode as string) ?? "files_with_matches";
      const caseInsensitive = args.case_insensitive as boolean | undefined;
      const contextBefore = args.context_before as number | undefined;
      const contextAfter = args.context_after as number | undefined;
      const headLimit = args.head_limit as number | undefined;
      const offset = (args.offset as number) ?? 0;

      const shellEsc = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";
      const parts = ["rg", "--color=never"];

      // Mode-specific flags
      if (mode === "files_with_matches") {
        parts.push("--files-with-matches");
      } else if (mode === "count") {
        parts.push("--count");
      } else {
        // content mode
        parts.push("--line-number", "--no-heading");
        if (contextBefore != null && contextBefore > 0) {
          parts.push(`-B${contextBefore}`);
        }
        if (contextAfter != null && contextAfter > 0) {
          parts.push(`-A${contextAfter}`);
        }
        // If neither -A nor -B specified, use --max-count to limit per-file
        if (contextBefore == null && contextAfter == null) {
          parts.push("--max-count=50");
        }
      }

      if (caseInsensitive) {
        parts.push("-i");
      }
      if (include) {
        parts.push("--glob", shellEsc(include));
      }
      parts.push("-e", shellEsc(pattern), shellEsc(searchPath));

      const { session, done } = executeCommand({
        command: parts.join(" "),
        cwd: getCwd(),
        timeout: 10_000,
        maxOutputBytes: 64 * 1024,
      });
      await done;

      if (session.exitCode === 1 && !session.output.trim()) {
        return {
          content: "No matches found.",
          exitCode: 0,
          isError: false,
        };
      }

      let output = session.output;

      // Cap individual line lengths to 500 chars to prevent minified/base64 flood
      if (mode === "content") {
        const MAX_LINE_LEN = 500;
        output = output
          .split("\n")
          .map((line) =>
            line.length > MAX_LINE_LEN
              ? line.slice(0, MAX_LINE_LEN) + "… [truncated]"
              : line,
          )
          .join("\n");
      }

      // Apply pagination (offset + head_limit)
      const defaultLimit = mode === "files_with_matches" ? 200 : 150;
      const limit = headLimit === 0 ? Infinity : (headLimit ?? defaultLimit);
      const lines = output.split("\n");
      const total = lines.length;

      // Apply offset then limit
      const sliced = lines.slice(offset, offset + limit);
      const paginated = sliced.join("\n");

      const parts2: string[] = [];
      if (paginated) parts2.push(paginated);

      // Show pagination info when offset is used or results were truncated
      if (offset > 0 || offset + limit < total) {
        const shown = sliced.length;
        const remaining = Math.max(0, total - offset - shown);
        parts2.push(
          `\n[Showing ${shown} results (offset=${offset}, limit=${limit === Infinity ? "unlimited" : limit})${remaining > 0 ? `, ${remaining} more available` : ""}]`,
        );
      }

      return {
        content: parts2.join("\n") || "No matches found.",
        exitCode: 0,
        isError: false,
      };
    },
  };
}
