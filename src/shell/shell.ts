import * as fs from "fs";
import * as os from "os";
import * as pty from "node-pty";
import type { EventBus } from "../core/event-bus.js";
import { InputHandler, type InputContext } from "./input-handler.js";
import { OutputParser } from "./output-parser.js";
import { getSettings } from "../core/settings.js";
import { clearOpost } from "../utils/tty.js";
import {
  pickStrategy,
  FALLBACK_STRATEGY,
  SUPPORTED_SHELL_NAMES,
  type ShellStrategy,
} from "./strategies/index.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface ShellHandlers {
  define: (name: string, fn: (...args: any[]) => any) => void;
  call: (name: string, ...args: any[]) => any;
}

/**
 * A claim on the shell's stdout-mute state. Acquire from shell.acquire*,
 * pair with release() in a try/finally. Token-shape forces symmetry —
 * the only way to influence the gate is to hold and release a scope.
 */
export interface ShellScope {
  readonly reason: string;
  release(): void;
}

export class Shell implements InputContext {
  private ptyProcess: pty.IPty;
  private bus: EventBus;
  private handlers: ShellHandlers;
  private inputHandler: InputHandler;
  private outputParser: OutputParser;
  // hardMute is unconditional (overlay compositing); softMute is overridable
  // by unmute (terminal_keys, permission UI). Gate: hard wins; otherwise
  // muted iff softMute held without an unmute.
  private hardMuteScopes = new Set<ShellScope>();
  private softMuteScopes = new Set<ShellScope>();
  private unmuteScopes = new Set<ShellScope>();
  private pendingEchoSkips = 0;
  private agentActive = false;
  private strategy: ShellStrategy;
  private tmpDir?: string;

  constructor(opts: {
    bus: EventBus;
    handlers: ShellHandlers;
    onShowAgentInfo?: () => { info: string; model?: string };
    cols: number;
    rows: number;
    shell: string;
    cwd: string;
    instanceId: string;
  }) {

    // Build environment — filter out undefined values (node-pty's native
    // posix_spawnp fails if any env value is undefined)
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) env[k] = v;
    }
    env.AGENT_SH = "1";

    // Spawn the user's shell with their full config (aliases, plugins, PATH,
    // completions, etc.). The core injects three invisible OSC hooks:
    //   - OSC 7: cwd tracking (required by OutputParser)
    //   - OSC 9999: prompt start marker (command boundary detection)
    //   - OSC 9998: prompt end marker (bracketed prompt capture)
    // Prompt theming is left entirely to the user's shell config. Per-shell
    // rc-file generation lives in src/shell/strategies/.
    const matched = pickStrategy(opts.shell);
    if (!matched) {
      console.warn(
        `Warning: agent-sh only supports ${SUPPORTED_SHELL_NAMES.join(", ")}. ` +
        `"${opts.shell}" may not work correctly — falling back to /bin/bash.`
      );
    }
    this.strategy = matched ?? FALLBACK_STRATEGY;
    const shellBin = matched ? opts.shell : "/bin/bash";

    // Per-instance tag so nested agent-sh hooks don't cross-trigger.
    const instanceTag = `id=${opts.instanceId}`;
    const settings = getSettings();
    const spawnConfig = this.strategy.prepareSpawn({
      tmpDirRoot: os.tmpdir(),
      instanceTag,
      showIndicator: settings.promptIndicator !== false,
      userHome: env.HOME || os.homedir(),
      env,
    });
    this.tmpDir = spawnConfig.tmpDir;
    Object.assign(env, spawnConfig.envOverrides);
    const shellArgs = spawnConfig.args;

    // Pause stdin before spawning PTY to avoid TTY contention on macOS.
    // The PTY will become the controlling terminal for the child shell.
    const wasRaw = process.stdin.isTTY && (process.stdin as any).isRaw;
    if (process.stdin.isTTY) {
      try {
        process.stdin.setRawMode(false);
        process.stdin.pause();
      } catch {
        // Ignore
      }
    }

    this.ptyProcess = pty.spawn(shellBin, shellArgs, {
      name: "xterm-256color",
      cols: opts.cols,
      rows: opts.rows,
      cwd: opts.cwd,
      env,
    });

    // Restore stdin after PTY is created
    if (process.stdin.isTTY) {
      try {
        process.stdin.resume();
        if (wasRaw) {
          process.stdin.setRawMode(true);
        }
      } catch {
        // Ignore - will be set up later in index.ts
      }
    }

    clearOpost();

    this.bus = opts.bus;
    this.handlers = opts.handlers;
    this.outputParser = new OutputParser(opts.bus, opts.cwd, instanceTag);

    // Ensure temp dir cleanup on abnormal exit (SIGKILL won't fire this,
    // but it covers uncaught exceptions and normal process.exit paths)
    if (this.tmpDir) {
      const dir = this.tmpDir;
      process.on("exit", () => {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
      });
    }

    this.inputHandler = new InputHandler({
      ctx: this,
      bus: opts.bus,
      handlers: opts.handlers,
      onShowAgentInfo: opts.onShowAgentInfo ?? (() => ({ info: "" })),
    });

    this.setupOutput();
    this.setupInput();
    this.setupAgentLifecycle();

    // Allow extensions to inject raw keystrokes into the PTY
    this.bus.on("shell:pty-write", ({ data }) => {
      this.ptyProcess.write(data);
    });

    // Allow extensions to resize the PTY (sends SIGWINCH to child)
    this.bus.on("shell:pty-resize", ({ cols, rows }) => {
      this.ptyProcess.resize(cols, rows);
    });

    // Compat shims for the bus-event API. shell:stdout-hold maps to hard
    // mute so terminal_keys' stdout-show can't paint through the overlay.
    let holdRefcount = 0;
    let holdScope: ShellScope | null = null;
    this.bus.on("shell:stdout-hold", () => {
      if (holdRefcount === 0) holdScope = this.acquireHardMute("bus:stdout-hold");
      holdRefcount++;
    });
    this.bus.on("shell:stdout-release", () => {
      if (holdRefcount === 0) return;
      holdRefcount--;
      if (holdRefcount === 0) { holdScope?.release(); holdScope = null; }
    });

    let showRefcount = 0;
    let showScope: ShellScope | null = null;
    this.bus.on("shell:stdout-show", () => {
      if (showRefcount === 0) showScope = this.acquireUnmute("bus:stdout-show");
      showRefcount++;
    });
    this.bus.on("shell:stdout-hide", () => {
      if (showRefcount === 0) return;
      showRefcount--;
      if (showRefcount === 0) { showScope?.release(); showScope = null; }
    });
  }

  // ── Scope-based gating ─────────────────────────────────────

  /** Compositing-layer claim — overrides any unmute. */
  acquireHardMute(reason: string): ShellScope {
    const scope: ShellScope = {
      reason,
      release: () => { this.hardMuteScopes.delete(scope); },
    };
    this.hardMuteScopes.add(scope);
    return scope;
  }

  /** Agent-turn / exec-style mute — overridable by unmute. */
  acquireMute(reason: string): ShellScope {
    const scope: ShellScope = {
      reason,
      release: () => { this.softMuteScopes.delete(scope); },
    };
    this.softMuteScopes.add(scope);
    return scope;
  }

  /** Force visible while held; overrides soft mutes only. */
  acquireUnmute(reason: string): ShellScope {
    const scope: ShellScope = {
      reason,
      release: () => { this.unmuteScopes.delete(scope); },
    };
    this.unmuteScopes.add(scope);
    return scope;
  }

  /** Swallow the next \n-terminated chunk from PTY (one per call). */
  skipNextLine(): void { this.pendingEchoSkips++; }

  private isHostMuted(): boolean {
    if (this.hardMuteScopes.size > 0) return true;
    return this.softMuteScopes.size > 0 && this.unmuteScopes.size === 0;
  }

  // ── InputContext implementation (delegates to OutputParser) ──

  isForegroundBusy(): boolean {
    return this.outputParser.isForegroundBusy();
  }

  getCwd(): string {
    return this.outputParser.getCwd();
  }

  isAgentActive(): boolean {
    return this.agentActive;
  }

  writeToPty(data: string): void {
    this.ptyProcess.write(data);
  }

  /**
   * Ask the shell to redraw its own prompt in place. The escape sequence is
   * defined per-strategy and bound in the generated rc file (zsh: ZLE widget,
   * bash: readline redraw-current-line). When the strategy returns null we
   * skip the in-place redraw and let freshPrompt do a heavy redraw instead.
   */
  redrawPrompt(): void {
    const result = this.bus.emitPipe("shell:redraw-prompt", {
      cwd: this.outputParser.getCwd(),
      kind: "redraw",
      handled: false,
    });
    if (result.handled) return;
    const escape = this.strategy.redrawEscape();
    if (escape) this.ptyProcess.write(escape);
  }

  /**
   * Heavy redraw: send \n to PTY to trigger a full precmd → prompt cycle.
   * Use this after agent responses where stdout has moved far from where
   * zle expects the cursor. The blank line is acceptable as a separator.
   *
   * Routed through shell:redraw-prompt pipe so extensions (e.g. overlay)
   * can suppress it by setting `handled: true`.
   */
  freshPrompt(): boolean {
    const result = this.bus.emitPipe("shell:redraw-prompt", {
      cwd: this.outputParser.getCwd(),
      kind: "fresh",
      handled: false,
    });
    if (!result.handled) {
      this.ptyProcess.write("\n");
      return true;
    }
    return false;
  }

  onCommandEntered(command: string, cwd: string): void {
    this.outputParser.onCommandEntered(command, cwd);
  }

  // ── PTY I/O wiring ─────────────────────────────────────────

  private setupOutput(): void {
    this.ptyProcess.onData((data: string) => {
      this.bus.emit("shell:pty-data", { raw: data });
      this.outputParser.processData(data);

      if (this.isHostMuted()) return;

      if (this.pendingEchoSkips > 0) {
        const nlIdx = data.indexOf("\n");
        if (nlIdx === -1) return;
        this.pendingEchoSkips--;
        const rest = data.slice(nlIdx + 1);
        if (rest) process.stdout.write(rest);
        return;
      }

      process.stdout.write(data);
    });
  }

  private setupInput(): void {
    process.stdin.on("data", (data: Buffer) => {
      const str = data.toString("utf-8");
      this.inputHandler.handleInput(str);
    });
  }

  /**
   * shell:on-processing-done splits into unconditional state cleanup
   * (release agent-turn scope) and an advisable redraw (freshPrompt).
   * RemoteSession suppresses the redraw, never the cleanup, so soft-mute
   * can't leak past the end of a turn even when overlays are involved.
   */
  private setupAgentLifecycle(): void {
    let agentTurnScope: ShellScope | null = null;

    this.handlers.define("shell:on-processing-start", () => {
      this.agentActive = true;
      agentTurnScope = this.acquireMute("agent-turn");
    });

    this.handlers.define("shell:on-processing-redraw", () => {
      if (!this.inputHandler.handleProcessingDone()) {
        if (this.freshPrompt()) this.skipNextLine();
      }
    });

    this.handlers.define("shell:on-processing-done", () => {
      this.agentActive = false;
      agentTurnScope?.release();
      agentTurnScope = null;
      this.handlers.call("shell:on-processing-redraw");
    });

    this.bus.on("agent:processing-start", () => {
      this.handlers.call("shell:on-processing-start");
    });

    this.bus.on("agent:processing-done", () => {
      this.handlers.call("shell:on-processing-done");
    });

    // Permission UI is briefly visible during the prompt; an unmute scope
    // overrides whatever mute is currently held, then releases cleanly.
    // Doesn't touch agent-turn state, so suppressed handlers can't leak.
    let permissionVisible: ShellScope | null = null;
    this.bus.on("permission:request", () => {
      permissionVisible?.release();
      permissionVisible = this.acquireUnmute("permission-ui");
    });
    this.bus.onPipeAsync("permission:request", async (payload) => {
      permissionVisible?.release();
      permissionVisible = null;
      return payload;
    });

    this.bus.onPipeAsync("shell:exec-request", async (payload) => {
      const visible = this.acquireUnmute("exec-request");
      this.skipNextLine();
      process.stdout.write("\r\n");
      this.bus.emit("shell:agent-exec-start", {});

      try {
        const output = await new Promise<{ output: string; cwd: string; exitCode: number | null }>((resolve, reject) => {
          const timeout = setTimeout(() => {
            this.bus.off("shell:command-done", handler);
            this.ptyProcess.write("\x03");
            reject(new Error("Shell exec timed out after 30s"));
          }, 30_000);

          const handler = (e: { command: string; output: string; cwd: string; exitCode: number | null }) => {
            clearTimeout(timeout);
            this.bus.off("shell:command-done", handler);
            resolve({ output: e.output, cwd: e.cwd, exitCode: e.exitCode });
          };
          this.bus.on("shell:command-done", handler);

          this.outputParser.onCommandEntered(payload.command, this.outputParser.getCwd());
          // Collapse literal newlines to spaces so the PTY receives a single-line
          // command. Multi-line commands (e.g. git commit -m "...\n...") would
          // cause the shell to execute prematurely, producing garbled output from
          // syntax highlighting plugins (zsh syntax highlighting, etc).
          const oneLine = payload.command.replace(/\n/g, " ");
          this.ptyProcess.write(oneLine + "\r");
        });

        return { ...payload, output: output.output, cwd: output.cwd, exitCode: output.exitCode, done: true };
      } finally {
        visible.release();
        this.bus.emit("shell:agent-exec-done", {});
      }
    });
  }

  // ── Public API (used by index.ts) ──

  /** Temp directory used for shell config and sockets. */
  getTmpDir(): string | undefined {
    return this.tmpDir;
  }

  resize(cols: number, rows: number): void {
    this.ptyProcess.resize(cols, rows);
  }

  onExit(callback: (e: { exitCode: number; signal?: number }) => void): void {
    this.ptyProcess.onExit(callback);
  }

  kill(): void {
    this.ptyProcess.kill();
    if (this.tmpDir) {
      fs.rmSync(this.tmpDir, { recursive: true, force: true });
    }
  }
}
