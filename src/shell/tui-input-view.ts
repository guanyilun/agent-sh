/**
 * Terminal renderer for the input-mode prompt and autocomplete dropdown.
 * Owns screen state (cursor row/col, autocomplete line count) and the
 * ANSI redraw. The controller drives it via a small VM shape.
 */

import { visibleLen } from "../utils/ansi.js";
import { palette as p } from "../utils/palette.js";
import type { RenderSurface } from "../utils/compositor.js";
import { StdoutSurface } from "../utils/compositor.js";

export interface PromptVM {
  showBuffer: boolean;
  displayText: string;
  displayCursor: number;
  indicator: string;
  promptIcon: string;
  agentInfo: { info: string };
}

export interface AutocompleteVM {
  items: { name: string; description: string }[];
  selected: number;
}

export class TuiInputView {
  private cursorRowsBelow = 0;
  private cursorTermCol = 1;
  private autocompleteLines = 0;
  private readonly surface: RenderSurface;

  constructor(surface?: RenderSurface) {
    this.surface = surface ?? new StdoutSurface();
  }

  resetCursor(): void {
    this.cursorRowsBelow = 0;
    this.cursorTermCol = 1;
  }

  enableModeKeys(): void {
    // Kitty progressive enhancement + bracket paste (Shift+Enter → \x1b[13;2u).
    this.surface.write("\x1b[>1u\x1b[?2004h");
  }

  disableModeKeys(): void {
    this.surface.write("\x1b[<u\x1b[?2004l");
  }

  clearPromptArea(): void {
    if (this.cursorRowsBelow > 0) {
      this.surface.write(`\x1b[${this.cursorRowsBelow}A`);
    }
    this.surface.write("\r\x1b[J");
    this.cursorRowsBelow = 0;
  }

  drawPrompt(vm: PromptVM): void {
    const termW = this.surface.columns;

    if (this.cursorRowsBelow > 0) {
      this.surface.write(`\x1b[${this.cursorRowsBelow}A`);
    }
    this.surface.write("\r\x1b[J");

    const infoPrefix = vm.agentInfo.info
      ? `${vm.agentInfo.info} ${p.success}${vm.indicator}${p.reset} `
      : `${p.success}${vm.indicator}${p.reset} `;
    const promptPrefix = infoPrefix + p.warning + p.bold + vm.promptIcon + " " + p.reset;
    const promptVisLen = visibleLen(infoPrefix) + visibleLen(vm.promptIcon) + 1;

    const display = vm.showBuffer ? vm.displayText : "";
    const dCursor = vm.showBuffer ? vm.displayCursor : 0;

    if (!vm.showBuffer) {
      this.surface.write(promptPrefix);
      const N = promptVisLen;
      this.cursorRowsBelow = N > 0 ? Math.ceil(N / termW) - 1 : 0;
      this.cursorTermCol = N === 0 ? 1 : (N % termW === 0 ? termW : (N % termW) + 1);
    } else if (!display.includes("\n")) {
      // DECSC/DECRC bracket the after-cursor text so the cursor lands mid-line.
      const before = display.slice(0, dCursor);
      const after = display.slice(dCursor);
      this.surface.write(
        promptPrefix + p.accent + before + p.reset +
        "\x1b7" +
        p.accent + after + p.reset +
        "\x1b8"
      );
      const cursorVisCol = promptVisLen + visibleLen(before);
      this.cursorRowsBelow = cursorVisCol > 0 ? Math.ceil(cursorVisCol / termW) - 1 : 0;
      this.cursorTermCol = cursorVisCol === 0 ? 1 : (cursorVisCol % termW === 0 ? termW : (cursorVisCol % termW) + 1);
    } else {
      const lines = display.split("\n");
      const indent = " ".repeat(promptVisLen);

      let charsRemaining = dCursor;
      let cursorLine = 0;
      for (let li = 0; li < lines.length; li++) {
        if (charsRemaining <= lines[li]!.length) {
          cursorLine = li;
          break;
        }
        charsRemaining -= lines[li]!.length + 1;
        cursorLine = li + 1;
      }

      let output = "";
      let cursorRowFromTop = 0;
      let rowsSoFar = 0;

      for (let li = 0; li < lines.length; li++) {
        const prefix = li === 0 ? promptPrefix : indent;
        const lineText = lines[li]!;
        const lineVisLen = promptVisLen + visibleLen(lineText);
        const lineTermRows = lineVisLen > 0 ? Math.ceil(lineVisLen / termW) : 1;

        if (li === cursorLine) {
          const before = lineText.slice(0, charsRemaining);
          const after = lineText.slice(charsRemaining);
          output += prefix + p.accent + before + p.reset;
          output += "\x1b7";
          output += p.accent + after + p.reset;

          const beforeVisCol = promptVisLen + visibleLen(before);
          cursorRowFromTop = rowsSoFar + (beforeVisCol > 0 ? Math.ceil(beforeVisCol / termW) - 1 : 0);
          this.cursorTermCol = beforeVisCol === 0 ? 1 : (beforeVisCol % termW === 0 ? termW : (beforeVisCol % termW) + 1);
        } else {
          output += prefix + p.accent + lineText + p.reset;
        }

        if (li < lines.length - 1) output += "\n";
        rowsSoFar += lineTermRows;
      }

      this.surface.write(output + "\x1b8");
      this.cursorRowsBelow = cursorRowFromTop;
    }
  }

  drawAutocomplete(vm: AutocompleteVM): void {
    if (vm.items.length === 0) return;

    const lines: string[] = [];
    for (let i = 0; i < vm.items.length; i++) {
      const item = vm.items[i]!;
      const selected = i === vm.selected;
      if (selected) {
        lines.push(
          `  \x1b[7m ${p.accent}${item.name.padEnd(12)}${p.reset}\x1b[7m ${item.description} ${p.reset}`
        );
      } else {
        lines.push(
          `   ${p.muted}${item.name.padEnd(12)} ${item.description}${p.reset}`
        );
      }
    }

    this.surface.write("\n" + lines.join("\n"));
    this.autocompleteLines = lines.length;

    if (this.autocompleteLines > 0) {
      this.surface.write(`\x1b[${this.autocompleteLines}A`);
    }
    // Absolute column set — preceding \n may have scrolled, invalidating DECSC.
    this.surface.write(`\x1b[${this.cursorTermCol}G`);
  }

  clearAutocomplete(): void {
    if (this.autocompleteLines <= 0) return;
    // CSI B (cursor down, bounded) so we don't scroll on the last row.
    for (let i = 0; i < this.autocompleteLines; i++) {
      this.surface.write("\x1b[B\x1b[2K");
    }
    this.surface.write(`\x1b[${this.autocompleteLines}A\x1b[${this.cursorTermCol}G`);
    this.autocompleteLines = 0;
  }
}
