/**
 * tunnel-vision — observe a remote shell session through the user's ssh PTY.
 *
 * Workflow:
 *   1. User runs `/tunnel-snippet` to print a small bash/zsh snippet.
 *   2. User ssh's into a remote host and pastes the snippet.
 *   3. The snippet installs preexec/precmd hooks that emit OSC lifecycle
 *      markers tagged with the *local* instanceId. The local OutputParser
 *      honors these markers as if they came from a local shell, so
 *      foregroundBusy flips correctly at each remote prompt cycle — that
 *      is what lets the user enter agent mode (`>`) while ssh'd in.
 *   4. While bound, the agent gets a `pty_send` tool that types commands
 *      into the user's interactive ssh session and reads back captured
 *      output. The binding survives reload_extensions; ssh-exit auto-
 *      teardown is detected by watching raw OSC 7 from the local outer
 *      shell after ssh terminates.
 *
 * Markers used:
 *   - OSC 9997 / 9999: agent-sh's standard preexec / prompt lifecycle
 *     markers (instanceId-tagged).
 *   - OSC 9996: tunnel-vision-only BIND marker (`vt=1` tag) — purely for
 *     this extension's binding-state machine; the local OutputParser does
 *     not process it.
 *
 * Usage:
 *   ash -e ./examples/extensions/tunnel-vision.ts
 *
 *   # Or install permanently
 *   cp examples/extensions/tunnel-vision.ts ~/.agent-sh/extensions/
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { ShellContext } from "agent-sh/types";

const BIND_RE = /\x1b\]9996;vt=([^;]+);BIND;([^;]*);([^\x07]*)\x07/;
const OSC7_RE = /\x1b\]7;file:\/\/[^/]*(\/[^\x07\x1b]*)/;

interface Binding {
  host: string;
  cwd: string;
  startedAt: number;
}

interface RingEntry {
  command: string;
  output: string;
  cwd: string;
  ts: number;
}

let binding: Binding | null = null;
const ring: RingEntry[] = [];
const RING_SIZE = 5;

let pendingExec: {
  resolve: (output: string) => void;
  timer: NodeJS.Timeout;
  buffer: string;
} | null = null;
let lastPtyDataAt = 0;
const IDLE_MS = 500;
const PARTIAL_TAIL_BYTES = 2048;
let bindingFile = "";

function pushRing(entry: RingEntry): void {
  ring.push(entry);
  while (ring.length > RING_SIZE) ring.shift();
}

function persistBinding(): void {
  if (!bindingFile) return;
  try {
    if (binding) {
      fs.writeFileSync(bindingFile, JSON.stringify(binding), "utf-8");
    } else {
      try { fs.unlinkSync(bindingFile); } catch { /* not present */ }
    }
  } catch { /* persistence is best-effort */ }
}

function loadBinding(): void {
  if (!bindingFile) return;
  try {
    const raw = fs.readFileSync(bindingFile, "utf-8");
    const parsed = JSON.parse(raw) as Binding;
    if (parsed && typeof parsed.host === "string") {
      binding = parsed;
    }
  } catch { /* nothing persisted */ }
}

function stripAnsiBasic(s: string): string {
  return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
}

function snippet(localIid: string): string {
  // Bash branch uses an `armed` flag (bash-preexec.sh pattern) so the
  // DEBUG trap only fires for user commands, not for commands inside
  // PROMPT_COMMAND itself. zsh uses native preexec/precmd hooks.
  return [
    `if [ -n "$BASH_VERSION" ]; then`,
    `  __vt_armed=0`,
    '  __vt_orig_pc="${PROMPT_COMMAND:-}"',
    `  __vt_preexec(){ [[ $__vt_armed -eq 1 ]] || return; __vt_armed=0; printf '\\033]9997;id=${localIid};%s\\007' "$BASH_COMMAND"; }`,
    `  __vt_precmd(){ printf '\\033]9999;id=${localIid};PROMPT\\007'; [ -z "$__vt_orig_pc" ] || eval "$__vt_orig_pc"; }`,
    `  PROMPT_COMMAND='__vt_precmd; __vt_armed=1'`,
    `  trap '__vt_preexec' DEBUG`,
    `  bind -m emacs '"\\e[9999~":redraw-current-line' 2>/dev/null`,
    `  bind -m vi-insert '"\\e[9999~":redraw-current-line' 2>/dev/null`,
    `  bind -m vi-command '"\\e[9999~":redraw-current-line' 2>/dev/null`,
    `elif [ -n "$ZSH_VERSION" ]; then`,
    `  preexec(){ printf '\\033]9997;id=${localIid};%s\\007' "$1"; }`,
    `  precmd(){ printf '\\033]9999;id=${localIid};PROMPT\\007'; }`,
    `  __vt_redraw(){ zle reset-prompt; }; zle -N __vt_redraw; bindkey '\\e[9999~' __vt_redraw`,
    `fi`,
    `printf '\\033]9996;vt=1;BIND;%s;%s\\007' "$(hostname)" "$PWD"`,
  ].join("\n");
}

function renderInjection(): string {
  if (!binding) return "";
  const lines: string[] = [];
  lines.push(`# Tunnel-vision active`);
  lines.push(``);
  lines.push(`Observing remote shell on **${binding.host}** (cwd: \`${binding.cwd}\`).`);
  if (ring.length > 0) {
    lines.push(``);
    lines.push(`Recent commands the user ran there:`);
    for (const e of ring) {
      const outFirst = e.output.split("\n").slice(0, 3).map(l => `    ${l}`).join("\n");
      lines.push(`  $ ${e.command}`);
      if (outFirst) lines.push(outFirst);
    }
  }
  lines.push(``);
  lines.push(`Run a command there with the \`pty_send\` tool. Stay aware: bytes you send appear in the user's terminal as if typed.`);
  return lines.join("\n");
}

export default function activate(ctx: ShellContext): void {
  bindingFile = path.join(ctx.getStoragePath("tunnel-vision"), "binding.json");
  loadBinding();

  ctx.bus.on("shell:pty-data", ({ raw }) => {
    lastPtyDataAt = Date.now();
    if (pendingExec) {
      pendingExec.buffer += raw;
      if (pendingExec.buffer.length > PARTIAL_TAIL_BYTES * 4) {
        pendingExec.buffer = pendingExec.buffer.slice(-PARTIAL_TAIL_BYTES * 4);
      }
    }
    const m = BIND_RE.exec(raw);
    if (m) {
      binding = {
        host: m[2] || "unknown",
        cwd: m[3] || "",
        startedAt: Date.now(),
      };
      persistBinding();
    }

    // Auto-teardown on ssh exit: while ssh runs, the local outer shell is
    // paused — no local OSC 7 emissions. When ssh exits, the outer shell
    // unblocks and its rcfile precmd emits OSC 7 with the local cwd. The
    // OutputParser's cwd-change event is gated by an equality check (cwd
    // before/after ssh is the same), so we detect raw OSC 7 here. Remote
    // shells that emit OSC 7 carry a remote path → won't match local cwd
    // → no false trigger.
    if (binding) {
      const o7 = OSC7_RE.exec(raw);
      if (o7) {
        try {
          const sawPath = decodeURIComponent(o7[1]);
          if (sawPath === (ctx.call("cwd") as string)) {
            binding = null;
            ring.length = 0;
            persistBinding();
            if (pendingExec) {
              clearTimeout(pendingExec.timer);
              pendingExec.resolve("[tunnel-vision: ssh session ended]");
              pendingExec = null;
            }
          }
        } catch { /* malformed OSC 7 — ignore */ }
      }
    }
  });

  // While bound, every shell:command-done is a remote command finishing
  // (local outer prompts won't fire while ssh is running).
  ctx.bus.on("shell:command-done", ({ command, output, cwd }) => {
    if (!binding) return;
    if (!command) return;
    pushRing({ command, output, cwd: cwd || binding.cwd, ts: Date.now() });
    if (pendingExec) {
      clearTimeout(pendingExec.timer);
      pendingExec.resolve(output || "[no output]");
      pendingExec = null;
    }
  });

  ctx.registerCommand("/tunnel-end", "Clear the active tunnel-vision binding", () => {
    if (!binding) {
      ctx.bus.emit("ui:info", { message: "No active tunnel-vision binding." });
      return;
    }
    const host = binding.host;
    binding = null;
    ring.length = 0;
    persistBinding();
    if (pendingExec) {
      clearTimeout(pendingExec.timer);
      pendingExec.resolve("[tunnel-vision: binding cleared]");
      pendingExec = null;
    }
    ctx.bus.emit("ui:info", { message: `Tunnel-vision binding to ${host} cleared.` });
  });

  ctx.registerInstruction("tunnel-vision",
`# Tunnel-vision — driving a remote shell through pty_send

When tunnel-vision is active (you'll see a "Tunnel-vision active" block in
context), the remote machine has no agent-sh — your only handle is
\`pty_send\`, which types into the user's interactive ssh session. The
PTY is serial (one command at a time, chain with \`&&\`); the user sees
every byte you send. Built-in tools like \`read_file\`, \`edit_file\`,
\`grep\`, \`glob\` operate on **your local filesystem**, not the remote —
do not use them to touch remote paths.

## Editing files on the remote — pattern ladder

Pick the lightest pattern that fits. Each step up costs more typing or
more bytes through the PTY.

1. **Pattern edits — \`sed -i\`.** Best for one-line swaps, config
   toggles, version bumps. Atomic, no payload concerns.
   \`pty_send({command: "sed -i 's/old/new/g' /path/file"})\`

   *Portability gotcha:* GNU sed (Linux) accepts \`sed -i\` with no
   argument. BSD sed (macOS) requires an empty backup-suffix arg:
   \`sed -i '' 's/old/new/g' file\`. If you don't know the OS, check
   first with \`uname\` or use the portable form
   \`sed -i.bak '...' file && rm file.bak\` which works on both.

2. **Small whole-file writes — here-doc.** Best for creating or
   rewriting files under ~2 KB. Use a single-quoted delimiter so
   \`$vars\` and backticks aren't expanded.
   \`pty_send({command: "cat > /tmp/x.sh <<'ASH_EOF'\\n#!/bin/bash\\necho hi\\nASH_EOF"})\`

3. **Structural edits — diff + patch.** Closest to local \`edit_file\`.
   Build the new version locally, \`diff -u old new > /tmp/p.patch\`,
   \`scp /tmp/p.patch user@host:/tmp/\`, then
   \`pty_send({command: "patch /path/file < /tmp/p.patch"})\`. \`patch\`
   fails loudly if the target drifted — that's good.

4. **Binaries or anything large — move bytes, don't type them.**
   \`scp\`, \`rsync\`, or \`curl\` from a known source. PTY typing is a
   last resort: payload caps, escape hazards, slow.

5. **Editor-driven (\`vim\`, \`nano\`).** Avoid. Brittle to any
   unexpected prompt, paging, or autocomplete. Reserve for appliance
   CLIs that don't offer scripting.

## Reading remote state

\`pty_send({command: "cat /path"})\`, \`ls -la\`, \`grep -r ...\`, etc.
Output comes back captured. **For files > a few hundred lines, default to
\`head -50\` / \`tail -50\` / \`sed -n '100,150p'\` / \`grep\` to bound
output.** Dumping a 5000-line log through the PTY is slow and floods
your context. If you genuinely need the whole file, scp it to local
first and then \`read_file\` it.

## Chain aggressively

The PTY is serial — each \`pty_send\` is a roundtrip. Bundle related
operations into one call: \`pwd && ls -la && cat README.md && hostname\`.
Pre-plan 3-5 step explorations rather than sending one command at a
time. If you genuinely need to react to output before the next step,
use one call per step but keep each call doing as much as it can.

## Interrupting

If a remote command runs long and you need to abort, send Ctrl-C:
\`pty_send({command: "\\x03", force: true})\`. \`force: true\` is
fire-and-forget — it bypasses both the serial mutex and the idle gate,
so it works even when your own previous \`pty_send\` is still pending.
The original pending call resolves naturally when the remote prompt
returns after the interrupt. \`\\x04\` (Ctrl-D / EOF) follows the same
pattern.

Do not use \`force: true\` for normal commands — they need the
prompt-wait to capture output.`
  );

  ctx.registerCommand("/tunnel-snippet", "Print the tunnel-vision snippet to paste on a remote shell", () => {
    const s = snippet(ctx.instanceId);
    ctx.bus.emit("ui:info", {
      message:
        `Paste this on the remote shell after sshing in (works for bash and zsh):\n\n${s}\n\n` +
        `Once pasted, every command you run there is observable to your local agent, ` +
        `and \`>\` will enter agent mode at remote prompts.`,
    });
  });

  ctx.registerTool({
    name: "pty_send",
    description:
      "Run a command in the user's interactive remote shell session (tunnel-vision). " +
      "Only available while a remote binding is active (user has sshed in and pasted " +
      "the tunnel-vision snippet). The command is written to the PTY and is visible " +
      "in the user's terminal as if typed. Use sparingly and announce intent first. " +
      "\n\nSERIAL ONLY — DO NOT call pty_send in parallel. The remote shell is a single " +
      "interactive PTY; only one command can run at a time. Concurrent calls fail " +
      "immediately. Chain instead in ONE call using `&&`, `;`, or `|` — e.g. " +
      "`pty_send({command: \"pwd && ls -la && hostname\"})`." +
      "\n\nIDLE GATE — between agent commands, pty_send refuses to write if the " +
      "PTY has been active in the last 500ms (user is typing, or a non-agent " +
      "command is finishing). Wait and retry." +
      "\n\nFORCE MODE — `force: true` is a fire-and-forget bypass. It skips both " +
      "the mutex and the idle gate, writes bytes immediately, and returns without " +
      "waiting for a prompt. Use it ONLY for control bytes that interrupt or signal:" +
      "\n  - Ctrl-C: `pty_send({command: \"\\x03\", force: true})` — kill a runaway " +
      "command (works even when your own previous pty_send is still pending)" +
      "\n  - Ctrl-D: `pty_send({command: \"\\x04\", force: true})` — send EOF" +
      "\nDo NOT use force for normal commands — they need the prompt-wait to capture " +
      "output.",
    input_schema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "Shell command to run on the remote host. Single line; no embedded newlines.",
        },
        force: {
          type: "boolean",
          description: "Bypass the idle gate. Use only for sending control characters (Ctrl-C) to interrupt a running command.",
        },
      },
      required: ["command"],
    },
    formatCall: (args) => {
      const cmd = typeof args.command === "string" ? args.command : "";
      return `pty_send: ${cmd.slice(0, 80)}`;
    },
    getDisplayInfo: () => ({ kind: "execute" as const }),
    execute: async (args) => {
      if (!binding) {
        return { content: "No tunnel-vision binding active. User must paste the /tunnel-snippet on a remote shell first.", exitCode: 1, isError: true };
      }
      const force = args.force === true;
      const command = typeof args.command === "string" ? args.command : "";
      if (!command) {
        return { content: "Provide a command.", exitCode: 1, isError: true };
      }

      if (force) {
        ctx.bus.emit("shell:pty-write", { data: command });
        const note = pendingExec
          ? "Existing pending command will resolve when remote prompt returns."
          : "No pending command — bytes sent without waiting for prompt.";
        return { content: `[pty_send: force-sent ${command.length} byte(s) without \\r. ${note}]`, exitCode: 0, isError: false };
      }

      if (pendingExec) {
        return { content: "Remote shell is busy with another pty_send. To interrupt, call pty_send with force:true and a control byte (e.g., \"\\x03\" for Ctrl-C).", exitCode: 1, isError: true };
      }
      const idleFor = Date.now() - lastPtyDataAt;
      if (idleFor < IDLE_MS) {
        return {
          content: `[pty_send: PTY active ${idleFor}ms ago (< ${IDLE_MS}ms idle gate). User is likely typing or a non-agent command is finishing. Wait and retry.]`,
          exitCode: 1,
          isError: true,
        };
      }

      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          if (pendingExec) {
            const buf = pendingExec.buffer;
            pendingExec = null;
            const tail = stripAnsiBasic(buf.slice(-PARTIAL_TAIL_BYTES)).trim();
            const partial = tail
              ? `\n\nPartial PTY activity captured (last ~${Math.min(tail.length, PARTIAL_TAIL_BYTES)} bytes, ANSI stripped):\n${tail}`
              : "\n\nNo PTY activity since the command was sent — likely stuck (e.g., shell waiting on heredoc continuation, or the command produced no output and is still running).";
            resolve({
              content: `[pty_send: timed out after 60s waiting for remote prompt]${partial}`,
              exitCode: 1,
              isError: true,
            });
          }
        }, 60_000);
        pendingExec = {
          timer,
          buffer: "",
          resolve: (output) => resolve({ content: output || "[no output]", exitCode: 0, isError: false }),
        };
        ctx.bus.emit("shell:pty-write", { data: command + "\r" });
      });
    },
  });

  ctx.registerContextProducer("tunnel-vision", () =>
    binding ? renderInjection() : null,
  );
}
