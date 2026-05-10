/**
 * Emacs buffer extension.
 *
 * Mirrors the terminal-buffer extension but for a running Emacs server,
 * trading PTY screen-scraping for structural access via `emacsclient -e`.
 *
 * Registers three agent tools (only when `emacsclient` is available and
 * a server is reachable):
 *
 *   - emacs_read  : structured snapshot of the selected window —
 *                   buffer, file, mode, point, narrowing, modeline,
 *                   echo area, and the visible region (window-start
 *                   to window-end). Optional all-windows mode.
 *
 *   - emacs_keys  : send a `kbd`-notation key sequence
 *                   (e.g. "C-x C-s", "SPC f f"). Goes through Emacs's
 *                   own key parser, so failed chords don't leak as
 *                   literal text and Doom leaders work without timing
 *                   tricks.
 *
 *   - emacs_eval  : evaluate arbitrary elisp inside the running Emacs.
 *                   Use for structural operations (buffer edits,
 *                   window manipulation, calling commands directly).
 *
 * All three round-trip results through a temp file as JSON. Requires
 * Emacs 27+ for `json-serialize`.
 *
 * Usage:
 *   ash -e ./examples/extensions/emacs-buffer.ts
 *
 *   # Or install permanently
 *   cp examples/extensions/emacs-buffer.ts ~/.agent-sh/extensions/
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import type { ExtensionContext } from "agent-sh/types";

function emacsclientAvailable(): boolean {
  // `emacsclient -e t` exits 0 only if a server is actually reachable.
  const r = spawnSync("emacsclient", ["-e", "t"], { encoding: "utf-8" });
  return r.status === 0;
}

function evalToJson<T = unknown>(body: string): T {
  const out = path.join(
    os.tmpdir(),
    `agent-sh-emacs-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  );
  // Compute the result *before* with-temp-file: inside its body, current-buffer
  // is the temp buffer, and execute-kbd-macro can shift current-buffer to the
  // user's live buffer mid-flight, causing (insert ...) to write JSON into it.
  const wrapped = `(let ((__result (progn ${body}))) (with-temp-file ${JSON.stringify(out)} (insert (json-serialize __result))))`;
  const r = spawnSync("emacsclient", ["-e", wrapped], { encoding: "utf-8" });
  if (r.status !== 0) {
    try { fs.unlinkSync(out); } catch { /* ignore */ }
    throw new Error(`emacsclient failed: ${(r.stderr || r.stdout || "").trim()}`);
  }
  let json: string;
  try {
    json = fs.readFileSync(out, "utf-8");
  } finally {
    try { fs.unlinkSync(out); } catch { /* ignore */ }
  }
  return JSON.parse(json) as T;
}

// Used by emacs_eval, where the result might not be JSON-serializable.
function evalPrinted(body: string): string {
  const r = spawnSync("emacsclient", ["-e", body], { encoding: "utf-8" });
  if (r.status !== 0) {
    throw new Error(`emacsclient failed: ${(r.stderr || r.stdout || "").trim()}`);
  }
  return r.stdout.replace(/\n$/, "");
}

interface WindowSnapshot {
  selected: boolean;
  buffer: string;
  file: string | null;
  mode: string;
  modified: boolean;
  narrowed: boolean;
  point: number;
  line: number;
  column: number;
  window_start: number;
  window_end: number;
  visible: string;
  modeline: string;
}

interface EmacsSnapshot {
  windows: WindowSnapshot[];
  echo_area: string | null;
  minibuffer_active: boolean;
  minibuffer_prompt: string | null;
  minibuffer_contents: string | null;
}

// Plist for one window. Conventions: t / :false for booleans (json-serialize
// would otherwise map nil → {}, not null), :null for explicit nulls.
const WINDOW_PLIST = `
  (let* ((buf (window-buffer w))
         (s (window-start w))
         (e (window-end w t)))
    (with-current-buffer buf
      (save-excursion
        (goto-char (window-point w))
        (list
          :selected (if (eq w (selected-window)) t :false)
          :buffer (buffer-name)
          :file (or (buffer-file-name) :null)
          :mode (symbol-name major-mode)
          :modified (if (buffer-modified-p) t :false)
          :narrowed (if (or (/= (point-min) 1) (/= (point-max) (1+ (buffer-size)))) t :false)
          :point (point)
          :line (line-number-at-pos (point))
          :column (current-column)
          :window_start s
          :window_end e
          :visible (buffer-substring-no-properties s e)
          :modeline (substring-no-properties (format-mode-line mode-line-format nil w))))))
`;

function snapshotElisp(allWindows: boolean): string {
  const winList = allWindows
    ? "(window-list)"
    : "(list (selected-window))";
  return `
    (list
      :windows (vconcat
        (mapcar (lambda (w) ${WINDOW_PLIST}) ${winList}))
      :echo_area (or (current-message) :null)
      :minibuffer_active (if (active-minibuffer-window) t :false)
      :minibuffer_prompt (or (and (active-minibuffer-window)
                                  (with-current-buffer (window-buffer (minibuffer-window))
                                    (or (minibuffer-prompt) "")))
                             :null)
      :minibuffer_contents (or (and (active-minibuffer-window)
                                    (with-current-buffer (window-buffer (minibuffer-window))
                                      (minibuffer-contents-no-properties)))
                               :null))
  `;
}

function snapshot(allWindows: boolean): EmacsSnapshot {
  return evalToJson<EmacsSnapshot>(snapshotElisp(allWindows));
}

function renderWindow(w: WindowSnapshot, idx: number): string {
  const tag = w.selected ? "selected" : `window ${idx}`;
  const flags: string[] = [];
  if (w.modified) flags.push("modified");
  if (w.narrowed) flags.push("narrowed");
  const flagsStr = flags.length ? ` [${flags.join(", ")}]` : "";
  const fileStr = w.file ? ` file=${w.file}` : "";
  const visible = markCursor(w.visible, w.point - w.window_start);

  return [
    `── ${tag}${flagsStr} ──`,
    `buffer=${w.buffer}${fileStr} mode=${w.mode}`,
    `point=${w.point} line=${w.line} col=${w.column}`,
    `modeline: ${w.modeline}`,
    `visible (${w.window_start}..${w.window_end}):`,
    visible,
  ].join("\n");
}

function markCursor(visible: string, offset: number): string {
  if (offset < 0 || offset > visible.length) return visible;
  return visible.slice(0, offset) + "▮" + visible.slice(offset);
}

function renderSnapshot(snap: EmacsSnapshot): string {
  const parts = snap.windows.map((w, i) => renderWindow(w, i));
  if (snap.minibuffer_active && snap.minibuffer_prompt !== null) {
    parts.push(
      `── minibuffer ──\n${snap.minibuffer_prompt}${snap.minibuffer_contents ?? ""}`,
    );
  }
  if (snap.echo_area) {
    parts.push(`── echo area ──\n${snap.echo_area}`);
  }
  return parts.join("\n\n");
}

export default function activate(ctx: ExtensionContext): void {
  const { registerTool } = ctx;
  if (!emacsclientAvailable()) return;

  registerTool({
    name: "emacs_read",
    description:
      "Read the state of the user's running Emacs: selected window's buffer, " +
      "file path, major mode, point (line/column), narrowing, modeline, the " +
      "currently visible region (window-start to window-end) with a ▮ cursor " +
      "marker, plus the echo area / minibuffer if active. With all_windows=true, " +
      "returns the same data for every visible window. Use this to ground answers " +
      "in what the user is actually looking at, not just guessing from filenames. " +
      "Far more reliable than terminal_read for Emacs — it sees structure, not pixels.",
    input_schema: {
      type: "object",
      properties: {
        all_windows: {
          type: "boolean",
          description:
            "Include every visible window in the current frame, not just the " +
            "selected one. Default: false.",
        },
      },
    },
    showOutput: true,
    getDisplayInfo: () => ({ kind: "read" as const, icon: "⌬", locations: [] }),

    async execute(args) {
      const all = (args.all_windows as boolean) ?? false;
      try {
        const snap = snapshot(all);
        return { content: renderSnapshot(snap), exitCode: 0, isError: false };
      } catch (e) {
        return {
          content: `emacs_read failed: ${(e as Error).message}`,
          exitCode: 1,
          isError: true,
        };
      }
    },
  });

  registerTool({
    name: "emacs_keys",
    description:
      "Send a key sequence to the user's running Emacs, parsed by Emacs itself " +
      "via `kbd`. Use Emacs `kbd` notation:\n" +
      "  C-x C-s        — Ctrl+x Ctrl+s (save)\n" +
      "  M-x            — Meta/Alt+x\n" +
      "  C-M-f          — Ctrl+Meta+f\n" +
      "  SPC f f        — Doom/Spacemacs leader find-file (no timing tricks needed)\n" +
      "  RET ESC TAB DEL — named keys\n" +
      "  <up> <down>    — arrow keys\n\n" +
      "Why this beats terminal_keys for Emacs: the key parser is authoritative, so " +
      "C-c works as a prefix without queueing garbage, leader keys resolve without " +
      "inter-key delays, and failed chords surface as a `kbd` parse error instead of " +
      "leaking into the buffer as text. Returns a fresh emacs_read snapshot after " +
      "the keys execute.",
    input_schema: {
      type: "object",
      properties: {
        keys: {
          type: "string",
          description:
            "A `kbd`-style key sequence, e.g. \"C-x C-s\", \"M-x find-file RET\", \"SPC f f\".",
        },
      },
      required: ["keys"],
    },
    showOutput: false,
    getDisplayInfo: () => ({ kind: "execute" as const, icon: "⌥", locations: [] }),
    formatCall: (args) => `keys: ${args.keys}`,

    async execute(args) {
      const keys = args.keys as string;
      try {
        // condition-case so kbd parse / runtime errors surface structurally
        // rather than as a non-zero emacsclient exit.
        const body = `
          (condition-case err
              (progn
                (execute-kbd-macro (kbd ${JSON.stringify(keys)}))
                ${snapshotElisp(false).trim()})
            (error (list :error (error-message-string err))))
        `;
        const result = evalToJson<EmacsSnapshot | { error: string }>(body);
        if ("error" in result) {
          return {
            content: `emacs_keys error: ${result.error}`,
            exitCode: 1,
            isError: true,
          };
        }
        return {
          content: `Keys sent.\n\n${renderSnapshot(result)}`,
          exitCode: 0,
          isError: false,
        };
      } catch (e) {
        return {
          content: `emacs_keys failed: ${(e as Error).message}`,
          exitCode: 1,
          isError: true,
        };
      }
    },
  });

  registerTool({
    name: "emacs_eval",
    description:
      "Evaluate elisp inside the user's running Emacs. The high-leverage tool: " +
      "buffer edits, window manipulation, calling named commands, reading any " +
      "data structure Emacs knows. Returns the printed value plus a fresh " +
      "emacs_read snapshot.\n\n" +
      "Useful idioms:\n" +
      "  (with-current-buffer \"foo.org\" (buffer-substring-no-properties (point-min) (point-max)))\n" +
      "  (with-current-buffer (window-buffer (selected-window)) (save-buffer))\n" +
      "  (call-interactively '+default/find-file)\n" +
      "  (split-window-right)\n\n" +
      "Caveat: this mutates the user's live editor. The change is undoable in the " +
      "buffer (C-/) but not all elisp side effects are reversible — be deliberate.",
    input_schema: {
      type: "object",
      properties: {
        elisp: {
          type: "string",
          description:
            "Elisp form(s) to evaluate. Multiple forms are allowed; only the last " +
            "form's value is returned in the printed-value section.",
        },
        skip_snapshot: {
          type: "boolean",
          description:
            "If true, don't return a post-eval emacs_read snapshot. Useful for " +
            "pure read-only evals where the snapshot would be noise. Default: false.",
        },
      },
      required: ["elisp"],
    },
    showOutput: false,
    getDisplayInfo: () => ({ kind: "execute" as const, icon: "λ", locations: [] }),
    formatCall: (args) => {
      const elisp = (args.elisp as string).trim().split("\n")[0];
      return elisp.length > 80 ? elisp.slice(0, 77) + "..." : elisp;
    },

    async execute(args) {
      const elisp = args.elisp as string;
      const skipSnap = (args.skip_snapshot as boolean) ?? false;
      try {
        const printed = evalPrinted(elisp);
        let suffix = "";
        if (!skipSnap) {
          try {
            suffix = "\n\n" + renderSnapshot(snapshot(false));
          } catch (e) {
            suffix = `\n\n(snapshot failed: ${(e as Error).message})`;
          }
        }
        return {
          content: `=> ${printed}${suffix}`,
          exitCode: 0,
          isError: false,
        };
      } catch (e) {
        return {
          content: `emacs_eval failed: ${(e as Error).message}`,
          exitCode: 1,
          isError: true,
        };
      }
    },
  });
}
