/**
 * TUI renderer extension.
 *
 * Subscribes to EventBus events and renders agent output to the terminal:
 * bordered markdown responses, spinner, tool call display, streaming
 * command output, error/info messages.
 *
 * Without this extension loaded, agent-shell runs headlessly — PTY
 * passthrough, agent queries, tool execution all function; output is
 * silently dropped. Alternative renderers (web UI, logging, minimal)
 * can subscribe to the same events.
 */
import { MarkdownRenderer } from "../utils/markdown.js";
import { CYAN, DIM, GREEN, RED, GRAY, BOLD, RESET } from "../utils/ansi.js";
import {
  renderToolCall,
  renderToolResult,
  startSpinner,
  stopSpinner as stopToolSpinner,
  type SpinnerState,
} from "../utils/tool-display.js";
import { renderDiff } from "../utils/diff-renderer.js";
import { renderBoxFrame } from "../utils/box-frame.js";
import type { DiffResult } from "../utils/diff.js";
import type { ExtensionContext } from "../types.js";

const MAX_COMMAND_OUTPUT_LINES = 30;

export default function activate({ bus }: ExtensionContext): void {
  let spinner: SpinnerState | null = null;
  let renderer: MarkdownRenderer | null = null;
  let commandOutputBuffer = "";
  let commandOutputLineCount = 0;
  let commandOutputOverflow = 0;
  let lastCommand = "";
  let isThinking = false;
  let showThinkingText = false;
  let lastTruncatedDiff: {
    filePath: string;
    diff: DiffResult;
    expandedLines?: string[]; // cached full render
    expanded: boolean;
  } | null = null;

  // ── Event subscriptions ─────────────────────────────────────

  bus.on("agent:query", (e) => {
    showUserQuery(e.query);
    startAgentResponse();
    startThinkingSpinner();
  });

  bus.on("agent:thinking-chunk", (e) => {
    if (!isThinking) {
      isThinking = true;
      stopCurrentSpinner();
      if (showThinkingText) {
        if (!renderer) startAgentResponse();
        renderer!.writeLine(`${DIM}${BOLD}💭 Thinking${RESET}`);
      } else {
        startThinkingSpinner("Thinking");
      }
    }
    if (showThinkingText && e.text) {
      if (!renderer) startAgentResponse();
      renderer!.push(`${DIM}${e.text}${RESET}`);
      flushOutput();
    }
  });

  bus.on("agent:response-chunk", (e) => writeAgentText(e.text));
  bus.on("agent:response-done", () => {
    isThinking = false;
    endAgentResponse();
  });

  bus.on("agent:tool-call", (e) => {
    lastCommand = e.tool;
  });

  bus.on("agent:tool-started", (e) => {
    stopCurrentSpinner();
    showToolCall(e.title, lastCommand);
    lastCommand = "";
  });

  bus.on("agent:tool-completed", (e) => showToolComplete(e.exitCode));
  bus.on("agent:tool-output-chunk", (e) => writeCommandOutput(e.chunk));
  bus.on("agent:tool-output", () => flushCommandOutput());

  bus.on("agent:cancelled", () => {
    isThinking = false;
    stopCurrentSpinner();
    showInfo("(cancelled)");
    endAgentResponse();
  });

  bus.on("agent:error", (e) => showError(e.message));

  // Flush rendering state and show inline diff for file writes
  bus.on("permission:request", (e) => {
    stopCurrentSpinner();
    flushCommandOutput();
    renderer?.flush();

    if (e.kind === "file-write" && e.metadata?.diff) {
      showFileDiff(
        e.title,
        e.metadata.diff as DiffResult,
      );
    } else {
      // Non-file permission (e.g. tool-call) — end response box
      // so interactive extensions can render their own UI
      endAgentResponse();
    }
  });

  bus.on("input:keypress", (e) => {
    if (e.key === "\x0f") expandLastDiff();       // Ctrl+O
    if (e.key === "\x14") toggleThinkingDisplay(); // Ctrl+T
  });
  bus.on("ui:info", (e) => showInfo(e.message));
  bus.on("ui:error", (e) => showError(e.message));

  // ── Rendering functions ─────────────────────────────────────

  function flushOutput(): void {
    if (process.stdout.writable) {
      try { process.stdout.write(""); } catch {}
    }
  }

  function startAgentResponse(): void {
    renderer = new MarkdownRenderer();
    process.stdout.write("\n");
    renderer.printTopBorder();
  }

  function endAgentResponse(): void {
    if (renderer) {
      renderer.flush();
      renderer.printBottomBorder();
      renderer = null;
    }
  }

  function showUserQuery(query: string): void {
    const termW = process.stdout.columns || 80;
    const boxW = Math.min(84, termW);
    const contentW = boxW - 4; // inside box padding

    // Wrap long queries to fit within box
    const lines: string[] = [];
    for (const raw of query.split("\n")) {
      if (raw.length <= contentW) {
        lines.push(`${CYAN}${raw}${RESET}`);
      } else {
        // Simple word wrap
        let remaining = raw;
        while (remaining.length > contentW) {
          let breakAt = remaining.lastIndexOf(" ", contentW);
          if (breakAt <= 0) breakAt = contentW;
          lines.push(`${CYAN}${remaining.slice(0, breakAt)}${RESET}`);
          remaining = remaining.slice(breakAt).trimStart();
        }
        if (remaining) lines.push(`${CYAN}${remaining}${RESET}`);
      }
    }

    const framed = renderBoxFrame(lines, {
      width: boxW,
      style: "rounded",
      borderColor: CYAN,
      title: `${CYAN}${BOLD}❯${RESET}`,
    });
    process.stdout.write("\n");
    for (const line of framed) {
      process.stdout.write(line + "\n");
    }
  }

  function writeAgentText(text: string): void {
    if (isThinking) {
      isThinking = false;
      if (showThinkingText && renderer) {
        renderer.flush();
        const termW = process.stdout.columns || 80;
        const w = Math.min(80, termW);
        renderer.writeLine(`${DIM}${"─".repeat(w)}${RESET}`);
      }
    }
    stopCurrentSpinner();
    if (!renderer) startAgentResponse();
    renderer!.push(text);
    flushOutput();
  }

  function showToolCall(title: string, command?: string): void {
    stopCurrentSpinner();
    if (!renderer) startAgentResponse();
    renderer!.flush();
    const termW = process.stdout.columns || 80;
    const lines = renderToolCall({ title, command: command || undefined }, termW);
    for (const line of lines) {
      renderer!.writeLine(line);
    }
    // Reset output tracking for the new tool
    commandOutputLineCount = 0;
    commandOutputOverflow = 0;
  }

  function showToolComplete(exitCode: number | null): void {
    if (!renderer) return;
    const termW = process.stdout.columns || 80;
    const lines = renderToolResult({ exitCode }, termW);
    for (const line of lines) {
      renderer.writeLine(line);
    }
  }

  function startThinkingSpinner(label = "Thinking"): void {
    stopCurrentSpinner();
    spinner = startSpinner(label);
  }

  function stopCurrentSpinner(): void {
    if (spinner) {
      stopToolSpinner(spinner);
      spinner = null;
    }
  }

  function writeCommandOutput(chunk: string): void {
    if (!renderer) return;
    commandOutputBuffer += chunk;
    const lines = commandOutputBuffer.split("\n");
    commandOutputBuffer = lines.pop()!;
    for (const line of lines) {
      if (commandOutputLineCount < MAX_COMMAND_OUTPUT_LINES) {
        renderer.writeLine(`${DIM}  ${line}${RESET}`);
        commandOutputLineCount++;
      } else {
        commandOutputOverflow++;
      }
    }
  }

  function flushCommandOutput(): void {
    if (!renderer) return;
    if (commandOutputBuffer) {
      if (commandOutputLineCount < MAX_COMMAND_OUTPUT_LINES) {
        renderer.writeLine(`${DIM}  ${commandOutputBuffer}${RESET}`);
        commandOutputLineCount++;
      } else {
        commandOutputOverflow++;
      }
      commandOutputBuffer = "";
    }
    if (commandOutputOverflow > 0) {
      renderer.writeLine(`${DIM}  … ${commandOutputOverflow} more lines${RESET}`);
      commandOutputOverflow = 0;
    }
  }

  const DIFF_MAX_LINES = 20;

  function showFileDiff(filePath: string, diff: DiffResult): void {
    if (diff.isIdentical) return;

    const termW = process.stdout.columns || 80;
    const boxW = Math.min(84, termW);
    const contentW = boxW - 4; // inside box padding

    const stats = diff.isNewFile
      ? `${GREEN}+${diff.added}${RESET}`
      : `${GREEN}+${diff.added}${RESET} ${RED}-${diff.removed}${RESET}`;
    const title = `${DIM}${filePath}${RESET}  ${stats}`;

    // Render with limit to check if truncated
    const diffLines = renderDiff(diff, {
      width: contentW,
      filePath,
      maxLines: DIFF_MAX_LINES,
      trueColor: true,
      mode: "unified",
    });

    // Check if the diff was truncated (last line contains "… N more lines")
    const lastLine = diffLines[diffLines.length - 1] ?? "";
    const isTruncated = lastLine.includes("… ");

    if (isTruncated) {
      lastTruncatedDiff = { filePath, diff, expanded: false };
    } else {
      lastTruncatedDiff = null;
    }

    // Skip the header line from renderDiff (we have our own title)
    const body = diffLines.length > 1 ? ["", ...diffLines.slice(1), ""] : diffLines;

    const footer = isTruncated
      ? [`  ${DIM}ctrl+o to expand${RESET}`]
      : undefined;

    const framed = renderBoxFrame(body, {
      width: boxW,
      style: "rounded",
      borderColor: DIM,
      title,
      footer,
    });

    if (!renderer) startAgentResponse();
    for (const line of framed) {
      renderer!.writeLine(line);
    }
  }

  function expandLastDiff(): void {
    if (!lastTruncatedDiff) return;

    const entry = lastTruncatedDiff;
    entry.expanded = !entry.expanded;

    if (!entry.expanded) {
      // Collapsing — show the truncated version again
      showFileDiffCached(entry);
      return;
    }

    // Build and cache the expanded frame if not already cached
    if (!entry.expandedLines) {
      const { filePath, diff } = entry;
      const termW = process.stdout.columns || 80;
      const boxW = Math.min(120, termW);
      const contentW = boxW - 4;

      const stats = diff.isNewFile
        ? `${GREEN}+${diff.added}${RESET}`
        : `${GREEN}+${diff.added}${RESET} ${RED}-${diff.removed}${RESET}`;
      const title = `${DIM}${filePath}${RESET}  ${stats}`;

      const diffLines = renderDiff(diff, {
        width: contentW,
        filePath,
        maxLines: 500,
        trueColor: true,
      });

      const body = diffLines.length > 1 ? ["", ...diffLines.slice(1), ""] : diffLines;

      entry.expandedLines = renderBoxFrame(body, {
        width: boxW,
        style: "rounded",
        borderColor: DIM,
        title,
        footer: [`  ${DIM}ctrl+o to collapse${RESET}`],
      });
    }

    process.stdout.write("\n");
    for (const line of entry.expandedLines) {
      process.stdout.write(line + "\n");
    }
  }

  /** Re-render the truncated diff (for collapsing back). */
  function showFileDiffCached(entry: NonNullable<typeof lastTruncatedDiff>): void {
    const { filePath, diff } = entry;
    const termW = process.stdout.columns || 80;
    const boxW = Math.min(84, termW);
    const contentW = boxW - 4;

    const stats = diff.isNewFile
      ? `${GREEN}+${diff.added}${RESET}`
      : `${GREEN}+${diff.added}${RESET} ${RED}-${diff.removed}${RESET}`;
    const title = `${DIM}${filePath}${RESET}  ${stats}`;

    const diffLines = renderDiff(diff, {
      width: contentW,
      filePath,
      maxLines: DIFF_MAX_LINES,
      trueColor: true,
      mode: "unified",
    });

    const body = diffLines.length > 1 ? ["", ...diffLines.slice(1), ""] : diffLines;

    const framed = renderBoxFrame(body, {
      width: boxW,
      style: "rounded",
      borderColor: DIM,
      title,
      footer: [`  ${DIM}ctrl+o to expand${RESET}`],
    });

    process.stdout.write("\n");
    for (const line of framed) {
      process.stdout.write(line + "\n");
    }
  }

  function toggleThinkingDisplay(): void {
    showThinkingText = !showThinkingText;
    const state = showThinkingText ? "on" : "off";
    process.stdout.write(`\n${DIM}Thinking display: ${state}${RESET}\n`);
  }

  function showError(message: string): void {
    process.stdout.write(`\n${RED}Error: ${message}${RESET}\n`);
  }

  function showInfo(message: string): void {
    process.stdout.write(`${GRAY}${message}${RESET}\n`);
  }
}
