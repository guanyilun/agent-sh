/**
 * Terminal buffer extension.
 *
 * Registers two agent tools:
 *   - terminal_read: get the current screen contents + cursor position
 *   - terminal_keys: send raw keystrokes into the user's live PTY
 *
 * Together these let the agent operate inside interactive programs
 * (vim, htop, less, etc.) by reading the screen and typing keys.
 *
 * Requires xterm in the extension directory:
 *   npm install @xterm/headless@5.5.0 @xterm/addon-serialize@0.13.0
 *
 * Core already loads xterm lazily (for floating-panel compositing), so
 * installing these deps anywhere on the NODE_PATH is enough.
 */
import type { ExtensionContext } from "agent-sh/types";

const NAMED_KEYS: Record<string, string> = {
  RET: "\r", ENTER: "\r", CR: "\r",
  ESC: "\x1b",
  TAB: "\t",
  BS: "\x7f", BACKSPACE: "\x7f",
  DEL: "\x1b[3~", DELETE: "\x1b[3~",
  SPC: " ", SPACE: " ",
  UP: "\x1b[A", DOWN: "\x1b[B", RIGHT: "\x1b[C", LEFT: "\x1b[D",
  HOME: "\x1b[H", END: "\x1b[F",
  PGUP: "\x1b[5~", PGDN: "\x1b[6~",
};

function ctrlByte(ch: string): string {
  if (ch === " ") return "\x00";
  const code = ch.charCodeAt(0);
  if (code >= 0x40 && code <= 0x7e) return String.fromCharCode(code & 0x1f);
  throw new Error(`Cannot apply Ctrl modifier to ${JSON.stringify(ch)}`);
}

function parseToken(body: string): string {
  if (!body) throw new Error("Empty key token <>");
  const upper = body.toUpperCase();
  if (upper in NAMED_KEYS) return NAMED_KEYS[upper];

  const fn = /^F(\d{1,2})$/i.exec(body);
  if (fn) {
    const n = parseInt(fn[1], 10);
    const map: Record<number, string> = {
      1: "\x1bOP", 2: "\x1bOQ", 3: "\x1bOR", 4: "\x1bOS",
      5: "\x1b[15~", 6: "\x1b[17~", 7: "\x1b[18~", 8: "\x1b[19~",
      9: "\x1b[20~", 10: "\x1b[21~", 11: "\x1b[23~", 12: "\x1b[24~",
    };
    if (n in map) return map[n];
    throw new Error(`Unknown function key <${body}>`);
  }

  let rest = body;
  let ctrl = false, meta = false;
  while (true) {
    if (/^C-/i.test(rest)) { ctrl = true; rest = rest.slice(2); }
    else if (/^M-/i.test(rest) || /^A-/i.test(rest)) { meta = true; rest = rest.slice(2); }
    else break;
  }

  let core: string;
  const restUpper = rest.toUpperCase();
  if (restUpper in NAMED_KEYS) core = NAMED_KEYS[restUpper];
  else if (rest.length === 1) core = rest;
  else throw new Error(`Unparseable key token <${body}>`);

  if (ctrl) {
    if (core.length !== 1) {
      throw new Error(`Ctrl modifier on multi-byte key <${body}> not supported`);
    }
    core = ctrlByte(core);
  }
  if (meta) core = "\x1b" + core;
  return core;
}

/**
 * Tokenize a `keys` string into chords — atomic units that get written
 * separately when inter_key_ms > 0, so multi-key leaders resolve under
 * the leader timer.
 */
export function tokenizeKeys(input: string): string[] {
  const chords: string[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === "<") {
      const end = input.indexOf(">", i + 1);
      if (end === -1) throw new Error(`Unterminated key token starting at index ${i}`);
      chords.push(parseToken(input.slice(i + 1, end)));
      i = end + 1;
      continue;
    }
    if (ch === "\\" && i + 1 < input.length) {
      const next = input[i + 1];
      if (next === "r") { chords.push("\r"); i += 2; continue; }
      if (next === "n") { chords.push("\n"); i += 2; continue; }
      if (next === "t") { chords.push("\t"); i += 2; continue; }
      if (next === "\\") { chords.push("\\"); i += 2; continue; }
      if (next === "0") { chords.push("\0"); i += 2; continue; }
      if (next === "x" && i + 3 < input.length) {
        const hex = input.slice(i + 2, i + 4);
        if (/^[0-9a-fA-F]{2}$/.test(hex)) {
          chords.push(String.fromCharCode(parseInt(hex, 16)));
          i += 4;
          continue;
        }
      }
      chords.push(ch);
      i += 1;
      continue;
    }
    chords.push(ch);
    i += 1;
  }
  return chords;
}

function settle(ms = 100): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function diffScreens(before: string, after: string): string {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  const max = Math.max(beforeLines.length, afterLines.length);
  const changes: string[] = [];
  for (let i = 0; i < max; i++) {
    const a = beforeLines[i] ?? "";
    const b = afterLines[i] ?? "";
    if (a !== b) changes.push(`row ${i}: ${JSON.stringify(a)} → ${JSON.stringify(b)}`);
  }
  if (changes.length === 0) return "(no visible change)";
  if (changes.length > 12) return `${changes.length} rows changed (see full screen below)`;
  return changes.join("\n");
}

export default function activate(ctx: ExtensionContext): void {
  const { bus } = ctx; const { registerTool } = ctx.agent;
  const tb = ctx.call("terminal-buffer");
  if (!tb) return; // @xterm/headless not installed, or shell frontend not loaded

  registerTool({
    name: "terminal_read",
    description:
      "Read what is currently visible on the user's terminal screen. Returns clean text (ANSI stripped) " +
      "with cursor position and whether an alternate-screen program (vim, htop, less) is active. " +
      "Use this to observe what the user sees — helpful for answering questions about terminal output, " +
      "diagnosing errors on screen, or checking state before/after sending keystrokes with terminal_keys.",
    input_schema: {
      type: "object",
      properties: {
        include_scrollback: {
          type: "boolean",
          description:
            "If true, include scrollback buffer (content that scrolled off screen) " +
            "in addition to the visible viewport. Useful for capturing output from " +
            "long-running or streaming commands. Default: false.",
        },
      },
    },
    showOutput: true,

    getDisplayInfo: () => ({
      kind: "read" as const,
      icon: "⊞",
      locations: [],
    }),

    async execute(args) {
      const includeScrollback = (args.include_scrollback as boolean) ?? false;
      const { text, altScreen, cursorX, cursorY } = tb.readScreen({ includeScrollback });
      const info = [
        altScreen ? "mode: alternate screen" : "mode: normal",
        `cursor: row=${cursorY} col=${cursorX}`,
      ].join(", ");

      return {
        content: `[${info}]\n\n${text}`,
        exitCode: 0,
        isError: false,
      };
    },
  });

  registerTool({
    name: "terminal_keys",
    description:
      "Send keystrokes directly into the user's live terminal PTY, as if the user typed them. " +
      "Use this to interact with programs already running in the terminal (vim, htop, less, ssh, REPLs, etc.) " +
      "or to type commands at the shell prompt.\n\n" +
      "Preferred input: named-key tokens in angle brackets. They are unambiguous and let inter_key_ms " +
      "delay the right boundaries (one chord per token):\n" +
      "  <RET> <ESC> <TAB> <BS> <DEL> <SPC>\n" +
      "  <UP> <DOWN> <LEFT> <RIGHT> <HOME> <END> <PGUP> <PGDN>\n" +
      "  <F1>..<F12>\n" +
      "  <C-x> = Ctrl+x, <M-x> = Meta/Alt+x, <C-M-x> = Ctrl+Meta+x\n\n" +
      "Backslash escapes are also accepted for raw bytes: \\r \\n \\t \\xNN.\n\n" +
      "Example: quit vim without saving — keys=\"<ESC>:q!<RET>\" (or the older \"\\x1b:q!\\r\").\n\n" +
      "Emacs pitfalls (read before sending keys to a running Emacs):\n" +
      "  - Abort is <C-g>, NOT <C-c>. <C-c> is a prefix key in Emacs and will queue garbage.\n" +
      "  - Failed multi-key chords get inserted into the buffer as literal text. Send small, " +
      "    well-tested sequences and call terminal_read between them to verify.\n" +
      "  - Doom/Spacemacs leader sequences (e.g. <SPC> f f) need timing — set inter_key_ms=50 " +
      "    or higher so the leader timer can resolve each chord.\n" +
      "  - For complex Emacs operations, prefer `emacsclient -e '(...)'` over typing keys.\n\n" +
      "This tool snapshots the screen before sending, sends the keys, then returns the resulting " +
      "screen plus a diff — no separate terminal_read is needed to see the effect. For multi-step " +
      "interactions, send small sequences and check the returned screen between them.",
    input_schema: {
      type: "object",
      properties: {
        keys: {
          type: "string",
          description:
            "The keystrokes to send. Prefer named tokens like <C-g>, <RET>, <ESC>, <SPC>. " +
            "Backslash escapes (\\r, \\t, \\x1b) and raw characters are also accepted.",
        },
        settle_ms: {
          type: "number",
          description:
            "Milliseconds to wait after the last chord for the terminal to settle before " +
            "snapshotting the screen (default: 150). Increase for slow programs.",
        },
        inter_key_ms: {
          type: "number",
          description:
            "Milliseconds to wait between chords. Default 0 (send all at once). Set ~50 for " +
            "Doom/Spacemacs leader sequences or any binding that depends on key-chord timeouts.",
        },
      },
      required: ["keys"],
    },
    showOutput: false,

    getDisplayInfo: () => ({
      kind: "execute" as const,
      icon: "⌨",
      locations: [],
    }),

    formatCall: (args) => {
      const keys = args.keys as string;
      return keys
        .replace(/\\x1b|\x1b/g, "ESC")
        .replace(/\\r|\r/g, "⏎")
        .replace(/\\n|\n/g, "↵")
        .replace(/\\t|\t/g, "TAB")
        .replace(/\\x03|\x03/g, "^C")
        .replace(/\\x04|\x04/g, "^D")
        .replace(/\\x07|\x07/g, "^G")
        .replace(/\\x7f|\x7f/g, "BS");
    },

    async execute(args) {
      const raw = args.keys as string;
      const settleMs = (args.settle_ms as number) ?? 150;
      const interKeyMs = (args.inter_key_ms as number) ?? 0;

      let chords: string[];
      try {
        chords = tokenizeKeys(raw);
      } catch (e) {
        return {
          content: `Invalid keys argument: ${(e as Error).message}`,
          exitCode: 1,
          isError: true,
        };
      }

      tb.flush();
      const before = tb.readScreen();

      bus.emit("shell:stdout-show", {});
      bus.emit("shell:host-write", { data: "\n" });

      for (let i = 0; i < chords.length; i++) {
        bus.emit("shell:pty-write", { data: chords[i] });
        if (interKeyMs > 0 && i < chords.length - 1) {
          await settle(interKeyMs);
        }
      }

      await settle(settleMs);
      bus.emit("shell:stdout-hide", {});

      tb.flush();
      const after = tb.readScreen();
      const info = [
        after.altScreen ? "mode: alternate screen" : "mode: normal",
        `cursor: row=${after.cursorY} col=${after.cursorX}`,
      ].join(", ");
      const diff = diffScreens(before.text, after.text);

      return {
        content:
          `Keys sent (${chords.length} chord${chords.length === 1 ? "" : "s"}).\n` +
          `Diff:\n${diff}\n\n` +
          `Screen after:\n[${info}]\n\n${after.text}`,
        exitCode: 0,
        isError: false,
      };
    },
  });
}
