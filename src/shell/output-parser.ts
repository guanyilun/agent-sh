import type { EventBus } from "../core/event-bus.js";
import { stripAnsi } from "../utils/ansi.js";

// Self-emitted form: \e]<num>;id=<own>;<body>\a — only this is honored.
// Anything else (mismatched tag, untagged) is ignored as opaque foreground output.
const PROMPT_RE = /\x1b\]9999;(?:id=([a-f0-9]+);)?PROMPT\x07/;
const PREEXEC_RE = /\x1b\]9997;(?:id=([a-f0-9]+);)?([^\x07]*)\x07/;
const READY_RE = /\x1b\]9998;(?:id=([a-f0-9]+);)?READY\x07/;

export interface OutputParserOpts {
  /** Optional shell-specific cleanup applied to raw output before stripAnsi. */
  cleanOutput?(raw: string): string;
}

export class OutputParser {
  private bus: EventBus;
  private cwd: string;
  private ownTag: string;
  private cleanOutput: (raw: string) => string;
  private currentOutputCapture = "";
  private lastCommand = "";
  private foregroundBusy = false;
  private promptReady = false;

  constructor(bus: EventBus, initialCwd: string, ownTag: string, opts: OutputParserOpts = {}) {
    this.bus = bus;
    this.cwd = initialCwd;
    this.ownTag = ownTag.startsWith("id=") ? ownTag.slice(3) : ownTag;
    this.cleanOutput = opts.cleanOutput ?? ((raw) => raw);
  }

  processData(data: string): void {
    this.parseOSC7(data);
    data = this.handlePreexec(data);
    this.parsePromptMarker(data);
    this.parsePromptEnd(data);
  }

  onCommandEntered(command: string, cwd: string): void {
    this.lastCommand = command;
    this.currentOutputCapture = "";
    this.bus.emit("shell:command-start", { command, cwd });
    if (!this.foregroundBusy) {
      this.foregroundBusy = true;
      this.bus.emit("shell:foreground-busy", { busy: true });
    }
  }

  isPromptReady(): boolean {
    return this.promptReady;
  }

  isForegroundBusy(): boolean {
    return this.foregroundBusy;
  }

  getCwd(): string {
    return this.cwd;
  }

  /** Pulls the actual command from the shell's OSC 9997 preexec marker —
   *  more reliable than the InputHandler's lineBuffer, which can't track
   *  history recall or tab completion. Returns data with the OSC stripped. */
  private handlePreexec(data: string): string {
    const match = PREEXEC_RE.exec(data);
    if (!match) return data;

    if (match[1] !== this.ownTag) {
      // Nested instance or untagged foreign emission — strip and ignore.
      return data.slice(0, match.index) + data.slice(match.index + match[0].length);
    }

    const command = match[2]!;
    this.lastCommand = command;
    // Discard echo accumulated before preexec.
    this.currentOutputCapture = "";

    if (!this.foregroundBusy) {
      this.foregroundBusy = true;
      this.bus.emit("shell:foreground-busy", { busy: true });
    }
    this.bus.emit("shell:command-start", { command, cwd: this.cwd });

    return data.slice(match.index + match[0].length);
  }

  private parseOSC7(data: string): void {
    const match = data.match(/\x1b\]7;file:\/\/[^/]*(\/[^\x07\x1b]*)/);
    if (match?.[1]) {
      const newCwd = decodeURIComponent(match[1]);
      if (newCwd !== this.cwd) {
        this.cwd = newCwd;
        this.bus.emit("shell:cwd-change", { cwd: this.cwd });
      }
    }
  }

  /** OSC 9999 marker — each occurrence finalizes the previous command's output. */
  private parsePromptMarker(data: string): void {
    const match = PROMPT_RE.exec(data);
    if (match) {
      if (match[1] !== this.ownTag) {
        // Nested or untagged emission: keep as opaque foreground output.
        this.currentOutputCapture += data;
        return;
      }
      const markerIdx = match.index;
      if (markerIdx > 0) {
        this.currentOutputCapture += data.slice(0, markerIdx);
      }
      this.promptReady = false;
      if (this.foregroundBusy) {
        this.foregroundBusy = false;
        this.bus.emit("shell:foreground-busy", { busy: false });
      }
      if (this.lastCommand) {
        const raw = this.cleanOutput(this.currentOutputCapture);
        const output = this.removeEchoedCommand(stripAnsi(raw).trim(), this.lastCommand);
        const outputRaw = this.removeEchoedCommand(raw.trim(), this.lastCommand);
        this.bus.emit("shell:command-done", {
          command: this.lastCommand,
          output,
          outputRaw,
          cwd: this.cwd,
          exitCode: null,
        });
      }
      this.lastCommand = "";
      this.currentOutputCapture = "";
    } else {
      // Cap to the tail so a long-running foreground program (tmux, vim)
      // emitting output without prompt markers can't grow this unboundedly.
      const MAX_CAPTURE = 128 * 1024;
      this.currentOutputCapture += data;
      if (this.currentOutputCapture.length > MAX_CAPTURE) {
        this.currentOutputCapture = this.currentOutputCapture.slice(-MAX_CAPTURE);
      }
    }
  }

  /** OSC 9998 — prompt is fully rendered and the shell is ready for input. */
  private parsePromptEnd(data: string): void {
    const match = READY_RE.exec(data);
    if (!match) return;
    if (match[1] !== this.ownTag) return;
    this.promptReady = true;
  }

  private removeEchoedCommand(output: string, command: string): string {
    const lines = output.split("\n");
    if (lines.length > 0 && stripAnsi(lines[0]!).includes(command.slice(0, 20))) {
      return lines.slice(1).join("\n").trim();
    }
    return output;
  }
}
