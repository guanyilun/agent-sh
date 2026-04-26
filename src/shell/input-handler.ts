import * as fs from "node:fs";
import * as path from "node:path";
import { LineEditor } from "../utils/line-editor.js";
import { CONFIG_DIR, getSettings } from "../settings.js";
import type { EventBus } from "../event-bus.js";
import type { InputModeConfig } from "../types.js";
import { TuiInputView } from "./tui-input-view.js";

const HISTORY_FILE = path.join(CONFIG_DIR, "input-history");

/**
 * Narrow contract between InputHandler and its host (Shell).
 * InputHandler never touches the PTY or EventBus directly —
 * it goes through this interface for all cross-cutting concerns.
 */
export interface InputContext {
  isForegroundBusy(): boolean;
  getCwd(): string;
  isAgentActive(): boolean;
  writeToPty(data: string): void;
  onCommandEntered(command: string, cwd: string): void;
  redrawPrompt(): void;
  freshPrompt(): void;
}

/**
 * Controller for the input-mode line editor and shell-passthrough buffer.
 * Owns: line buffer, mode dispatch, history, autocomplete model, key
 * decoding. Delegates all rendering to TuiInputView.
 */
export class InputHandler {
  private ctx: InputContext;
  private lineBuffer = "";
  private activeMode: InputModeConfig | null = null;
  private pendingReturnMode: string | null = null;
  private modes = new Map<string, InputModeConfig>();
  private modesById = new Map<string, InputModeConfig>();
  private editor = new LineEditor();
  private autocompleteActive = false;
  private autocompleteIndex = 0;
  private autocompleteItems: { name: string; description: string }[] = [];
  private history: string[] = [];
  private historyIndex = -1;
  private savedBuffer = "";
  private escapeTimer: ReturnType<typeof setTimeout> | null = null;
  private bus: EventBus;
  private onShowAgentInfo: () => { info: string; model?: string };
  private view: TuiInputView;

  constructor(opts: {
    ctx: InputContext;
    bus: EventBus;
    onShowAgentInfo: () => { info: string; model?: string };
    view?: TuiInputView;
  }) {
    this.ctx = opts.ctx;
    this.bus = opts.bus;
    this.onShowAgentInfo = opts.onShowAgentInfo;
    this.view = opts.view ?? new TuiInputView();
    this.loadHistory();

    this.bus.on("config:changed", () => {
      if (this.activeMode) this.drawPrompt();
    });

    this.bus.on("input-mode:register", (config) => {
      this.registerMode(config);
    });
  }

  private registerMode(config: InputModeConfig): void {
    if (this.modes.has(config.trigger)) {
      this.bus.emit("ui:error", {
        message: `Input mode "${config.id}" cannot register trigger "${config.trigger}" — already taken by "${this.modes.get(config.trigger)!.id}"`,
      });
      return;
    }
    this.modes.set(config.trigger, config);
    this.modesById.set(config.id, config);
  }

  private loadHistory(): void {
    try {
      const data = fs.readFileSync(HISTORY_FILE, "utf-8");
      this.history = data.split("\n").filter(Boolean);
    } catch {
      // No history file yet
    }
  }

  private saveHistory(): void {
    try {
      const { historySize } = getSettings();
      fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
      const lines = this.history.slice(-historySize);
      fs.writeFileSync(HISTORY_FILE, lines.join("\n") + "\n");
    } catch {
      // Non-critical — ignore write failures
    }
  }

  private drawPrompt(showBuffer = true): void {
    this.view.drawPrompt({
      showBuffer,
      displayText: this.editor.displayText,
      displayCursor: this.editor.displayCursor,
      indicator: this.activeMode?.indicator ?? "●",
      promptIcon: this.activeMode?.promptIcon ?? "❯",
      agentInfo: this.onShowAgentInfo(),
    });
  }

  handleInput(data: string): void {
    const intercepted = this.bus.emitPipe("input:intercept", { data, consumed: false });
    if (intercepted.consumed) return;

    if (this.ctx.isAgentActive()) {
      if (data === "\x03") {
        this.bus.emit("agent:cancel-request", {});
      } else if (data.length === 1 && data.charCodeAt(0) < 32) {
        this.bus.emit("input:keypress", { key: data });
      }
      return;
    }

    if (data.length === 1 && data.charCodeAt(0) < 32 && !this.activeMode) {
      const code = data.charCodeAt(0);
      if (code === 0x14 || code === 0x0f) { // Ctrl+T, Ctrl+O
        this.bus.emit("input:keypress", { key: data });
        return;
      }
      if (code !== 0x0d && code !== 0x03 && code !== 0x04 && code !== 0x09) {
        this.bus.emit("input:keypress", { key: data });
      }
    }

    if (this.activeMode) {
      this.handleModeInput(data);
      return;
    }

    for (let i = 0; i < data.length; i++) {
      const ch = data[i]!;

      if (ch === "\r") {
        if (this.lineBuffer.trim()) {
          this.ctx.onCommandEntered(this.lineBuffer.trim(), this.ctx.getCwd());
        }
        this.lineBuffer = "";
        this.ctx.writeToPty(ch);
      } else if (ch === "\x7f" || ch === "\b") {
        this.lineBuffer = this.lineBuffer.slice(0, -1);
        this.ctx.writeToPty(ch);
      } else if (ch === "\x03" || ch === "\x04") {
        this.lineBuffer = "";
        this.ctx.writeToPty(ch);
      } else if (ch === "\x0b" || ch === "\x15") {
        // Ctrl-K / Ctrl-U kill the line in the shell.
        this.lineBuffer = "";
        this.ctx.writeToPty(ch);
      } else if (ch === "\x1b") {
        // Forward whole escape sequence as a unit so payload bytes don't
        // leak into lineBuffer (e.g. OSC color-query response after a TUI app exits).
        let seq = ch;
        if (i + 1 < data.length) {
          const next = data[i + 1]!;
          if (next === "[") {
            seq += next; i++;
            while (i + 1 < data.length && data[i + 1]!.charCodeAt(0) < 0x40) {
              i++; seq += data[i]!;
            }
            if (i + 1 < data.length) { i++; seq += data[i]!; }
          } else if (next === "O") {
            seq += next; i++;
            if (i + 1 < data.length) { i++; seq += data[i]!; }
          } else if (next === "]" || next === "P" || next === "_" || next === "^") {
            // OSC/DCS/APC/PM — terminated by BEL or ST (ESC \).
            let j = i + 2;
            let termEnd = -1;
            while (j < data.length) {
              const c = data[j]!;
              if (c === "\x07") { termEnd = j; break; }
              if (c === "\x1b" && j + 1 < data.length && data[j + 1] === "\\") {
                termEnd = j + 1; break;
              }
              j++;
            }
            if (termEnd !== -1) {
              seq = data.slice(i, termEnd + 1);
              i = termEnd;
            } else {
              seq += next; i++;
            }
          } else {
            seq += next; i++;
          }
        }
        this.ctx.writeToPty(seq);
      } else if (ch.charCodeAt(0) < 32 && ch !== "\t") {
        this.ctx.writeToPty(ch);
      } else {
        const mode = this.modes.get(ch);
        if (this.lineBuffer === "" && mode && !this.ctx.isForegroundBusy()) {
          this.enterMode(mode);
          return;
        }
        if (!this.ctx.isForegroundBusy()) this.lineBuffer += ch;
        this.ctx.writeToPty(ch);
      }
    }
  }

  private enterMode(mode: InputModeConfig): void {
    this.activeMode = mode;
    this.editor.clear();
    this.view.enableModeKeys();
    this.drawPrompt(false);
  }

  private exitMode(): void {
    this.dismissAutocomplete();
    this.activeMode = null;
    this.editor.clear();
    this.view.disableModeKeys();
    this.view.clearPromptArea();
    this.view.resetCursor();
    this.printPrompt();
  }

  printPrompt(): void {
    this.ctx.redrawPrompt();
  }

  /** Called when agent processing completes. Returns true if the input
   *  handler re-entered a mode (so caller should skip shell prompt). */
  handleProcessingDone(): boolean {
    if (this.pendingReturnMode) {
      const mode = this.modesById.get(this.pendingReturnMode);
      this.pendingReturnMode = null;
      if (mode) {
        this.enterMode(mode);
        return true;
      }
    }
    return false;
  }

  private renderModeInput(): void {
    this.view.clearAutocomplete();
    this.drawPrompt();
    this.updateAutocomplete();
  }

  private updateAutocomplete(): void {
    const buf = this.editor.text;
    let command: string | null = null;
    let commandArgs: string | null = null;
    if (buf.startsWith("/")) {
      const spaceIdx = buf.indexOf(" ");
      if (spaceIdx !== -1) {
        command = buf.slice(0, spaceIdx);
        commandArgs = buf.slice(spaceIdx + 1);
      }
    }
    const { items } = this.bus.emitPipe("autocomplete:request", {
      buffer: buf,
      command,
      commandArgs,
      items: [],
    });
    if (items.length > 0) {
      this.autocompleteItems = items;
      this.autocompleteActive = true;
      if (this.autocompleteIndex >= items.length) this.autocompleteIndex = 0;
      this.view.drawAutocomplete({ items: this.autocompleteItems, selected: this.autocompleteIndex });
    } else {
      this.autocompleteActive = false;
      this.autocompleteItems = [];
    }
  }

  private applyAutocomplete(): void {
    if (!this.autocompleteActive || this.autocompleteItems.length === 0) return;
    const selected = this.autocompleteItems[this.autocompleteIndex];
    if (!selected) return;

    const atPos = this.editor.text.lastIndexOf("@");
    const isFileAc =
      atPos >= 0 &&
      (atPos === 0 || this.editor.text[atPos - 1] === " ") &&
      !this.editor.text.slice(atPos + 1).includes(" ");

    if (isFileAc) {
      this.editor.setText(
        this.editor.text.slice(0, atPos) + "@" + selected.name);
    } else {
      this.editor.setText(selected.name);
    }

    this.view.clearAutocomplete();
    this.autocompleteActive = false;
    this.autocompleteItems = [];
    this.autocompleteIndex = 0;

    this.drawPrompt();
    if (isFileAc) this.updateAutocomplete();
  }

  private dismissAutocomplete(): void {
    this.view.clearAutocomplete();
    this.autocompleteActive = false;
    this.autocompleteItems = [];
    this.autocompleteIndex = 0;
  }

  private handleModeInput(data: string): void {
    if (this.escapeTimer) {
      clearTimeout(this.escapeTimer);
      this.escapeTimer = null;
    }

    const actions = this.editor.feed(data);

    if (this.editor.hasPendingEscape()) {
      this.escapeTimer = setTimeout(() => {
        this.escapeTimer = null;
        const flushed = this.editor.flushPendingEscape();
        if (flushed.length > 0) this.processModeActions(flushed);
      }, 50);
    }

    this.processModeActions(actions);
  }

  private processModeActions(actions: ReturnType<typeof this.editor.feed>): void {
    for (const act of actions) {
      switch (act.action) {
        case "changed": {
          const switchMode = this.modes.get(this.editor.text);
          if (this.editor.text.length === 1 && switchMode && switchMode !== this.activeMode) {
            this.dismissAutocomplete();
            this.view.clearPromptArea();
            this.activeMode = switchMode;
            this.editor.clear();
            this.drawPrompt(false);
            break;
          }
          this.historyIndex = -1;
          this.autocompleteIndex = 0;
          this.renderModeInput();
          break;
        }

        case "submit": {
          if (this.autocompleteActive) {
            this.applyAutocomplete();
          }
          // Use editor.text (not act.buffer) so autocomplete selections take effect.
          const query = this.editor.text.trim();
          if (query) {
            if (this.history.length === 0 || this.history[this.history.length - 1] !== query) {
              this.history.push(query);
              this.saveHistory();
            }
          }
          this.historyIndex = -1;
          this.savedBuffer = "";
          this.view.clearAutocomplete();
          this.view.clearPromptArea();
          this.view.disableModeKeys();
          const currentMode = this.activeMode!;
          this.activeMode = null;
          this.editor.clear();
          this.view.resetCursor();
          this.dismissAutocomplete();
          if (query && query.startsWith("/")) {
            const spaceIdx = query.indexOf(" ");
            const name = spaceIdx === -1 ? query : query.slice(0, spaceIdx);
            const args = spaceIdx === -1 ? "" : query.slice(spaceIdx + 1).trim();
            this.bus.emit("command:execute", { name, args });
            if (currentMode.returnToSelf) {
              this.enterMode(currentMode);
            } else {
              this.ctx.freshPrompt();
            }
          } else if (query) {
            this.pendingReturnMode = currentMode.returnToSelf ? currentMode.id : null;
            currentMode.onSubmit(query, this.bus);
          } else {
            this.exitMode();
          }
          return;
        }

        case "cancel":
          if (this.autocompleteActive) {
            this.dismissAutocomplete();
            this.drawPrompt();
          } else {
            this.exitMode();
          }
          return;

        case "delete-empty":
          this.dismissAutocomplete();
          this.exitMode();
          return;

        case "tab":
          if (this.autocompleteActive) {
            this.applyAutocomplete();
          }
          break;

        case "arrow-up":
          if (this.autocompleteActive) {
            this.autocompleteIndex =
              this.autocompleteIndex === 0
                ? this.autocompleteItems.length - 1
                : this.autocompleteIndex - 1;
            this.view.clearAutocomplete();
            this.drawPrompt();
            this.view.drawAutocomplete({ items: this.autocompleteItems, selected: this.autocompleteIndex });
          } else if (this.history.length > 0) {
            if (this.historyIndex === -1) {
              this.savedBuffer = this.editor.text;
              this.historyIndex = this.history.length - 1;
            } else if (this.historyIndex > 0) {
              this.historyIndex--;
            }
            this.editor.setText(this.history[this.historyIndex]!);
            this.view.clearAutocomplete();
            this.drawPrompt();
          }
          break;

        case "arrow-down":
          if (this.autocompleteActive) {
            this.autocompleteIndex =
              this.autocompleteIndex === this.autocompleteItems.length - 1
                ? 0
                : this.autocompleteIndex + 1;
            this.view.clearAutocomplete();
            this.drawPrompt();
            this.view.drawAutocomplete({ items: this.autocompleteItems, selected: this.autocompleteIndex });
          } else if (this.historyIndex !== -1) {
            if (this.historyIndex < this.history.length - 1) {
              this.historyIndex++;
              this.editor.setText(this.history[this.historyIndex]!);
            } else {
              this.historyIndex = -1;
              this.editor.setText(this.savedBuffer);
            }
            this.view.clearAutocomplete();
            this.drawPrompt();
          }
          break;
      }
    }
  }
}
