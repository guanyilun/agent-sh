/**
 * Interactive shell passthrough for ashi.
 *
 * Usage:   ashi -e examples/extensions/ashi-shell-passthrough.ts
 * Config:  { "ashi-shell-passthrough": { "trigger": "ctrl+]" } }  // or "ctrl+\\", "^]"
 *
 * Press the trigger key (or run `/shell`) to hand the terminal to your live
 * shell PTY; press it again to return to ashi.
 */
import type { ExtensionContext } from "agent-sh/types";

interface TerminalBufferView {
  getScreenLines(rows?: number): string[];
  getCursor(): { x: number; y: number };
  readonly altScreen: boolean;
}

interface AshiKey {
  matches(name: string): boolean;
  isRelease(): boolean;
  isRepeat(): boolean;
}

function parseTrigger(spec: string): { name: string; byte: string } {
  const ch = (/^ctrl\+(.)$/i.exec(spec) ?? /^\^(.)$/.exec(spec))?.[1] ?? spec;
  return {
    name: `ctrl+${ch.toLowerCase()}`,
    byte: String.fromCharCode(ch.toUpperCase().charCodeAt(0) & 0x1f),
  };
}

function runPassthrough(ctx: ExtensionContext, closeByte: string): Promise<void> {
  const { bus } = ctx;
  return new Promise<void>((resolve) => {
    const tb = ctx.call("terminal-buffer") as TerminalBufferView | null;

    const onPtyData = ({ raw }: { raw: string }): void => { process.stdout.write(raw); };
    const onResize = (): void => bus.emit("shell:pty-resize", {
      cols: process.stdout.columns ?? 80,
      rows: process.stdout.rows ?? 24,
    });
    const onStdin = (chunk: Buffer): void => {
      const data = chunk.toString("latin1");
      if (data === closeByte) { cleanup(); resolve(); return; }
      bus.emit("shell:pty-write", { data });
    };
    const cleanup = (): void => {
      bus.off("shell:pty-data", onPtyData);
      process.stdin.off("data", onStdin);
      process.stdout.off("resize", onResize);
    };

    process.stdout.on("resize", onResize);
    bus.on("shell:pty-data", onPtyData);
    process.stdin.on("data", onStdin);
    onResize();

    if (tb && !tb.altScreen) {
      const cur = tb.getCursor();
      process.stdout.write(
        `\x1b[2J\x1b[H${tb.getScreenLines().join("\r\n")}\x1b[${cur.y + 1};${cur.x + 1}H`,
      );
    }
  });
}

export default function activate(ctx: ExtensionContext): void {
  const { bus } = ctx;
  const { trigger } = ctx.getExtensionSettings("ashi-shell-passthrough", { trigger: "ctrl+]" });
  const { name: triggerName, byte: triggerByte } = parseTrigger(trigger);

  const openShell = async (): Promise<void> => {
    if (!ctx.list().includes("ashi:terminal:yield")) {
      bus.emit("ui:error", { message: "shell passthrough needs a newer ashi (missing ashi:terminal:yield)" });
      return;
    }
    await ctx.call("ashi:terminal:yield", () => runPassthrough(ctx, triggerByte));
  };

  ctx.registerCommand(
    "shell",
    "Drop into your live shell — the agent sees what you run; the trigger key returns to ashi",
    openShell,
  );

  const bindHotkey = (): void => {
    const off = ctx.call("ashi:on-key", (key: AshiKey) => {
      if (key.isRelease() || key.isRepeat()) return;
      if (key.matches(triggerName)) { void openShell(); return { consume: true }; }
    });
    if (typeof off === "function") ctx.onDispose(() => off());
  };
  if (ctx.list().includes("ashi:on-key")) bindHotkey();
  else (bus.on as (event: string, fn: () => void) => void)("ashi:ready", bindHotkey);
}
