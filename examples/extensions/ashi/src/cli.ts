#!/usr/bin/env node
/**
 * ashi — ash (agent-sh's built-in agent) in an interactive TUI.
 */
import { createCore } from "agent-sh/core";
import { loadBuiltinExtensions } from "agent-sh/extensions";
import { loadExtensions } from "agent-sh/extension-loader";
import { activateAgent } from "agent-sh/agent";
import { getSettings } from "agent-sh/settings";
import { Shell } from "agent-sh/shell";
import { TerminalBuffer } from "agent-sh/utils/terminal-buffer";
import type { Terminal } from "agent-sh/shell/terminal";
import activateShellContext from "agent-sh/shell/context";
import type { AppConfig } from "agent-sh/types";

/** No-op: ashi renders via pi-tui, the PTY only needs to exist. */
function headlessTerminal(): Terminal {
  return {
    write() {},
    onInput: () => () => {},
    onResize: () => () => {},
    cols: () => 100,
    rows: () => 30,
  };
}

import { mountAshi } from "./frontend.js";
import { MultiSessionStore } from "./multi-session-store.js";
import { registerForkCommands, applyBranchMessages } from "./commands.js";
import { registerSessionCommands } from "./session-commands.js";
import { registerCompaction } from "./compaction.js";
import { registerCapture } from "./capture.js";
import { registerRenderDefaults } from "./hooks.js";
import { registerDefaultSchemaRenderers } from "./default-schema-renderers.js";
import { createPiTuiRenderer } from "./renderers/pi-tui/index.js";
import type { Renderer } from "./renderer.js";
import * as os from "node:os";
import * as path from "node:path";

function parseArgs(argv: string[]): AppConfig & { extensions?: string[]; continueLast: boolean } {
  let model: string | undefined;
  let apiKey: string | undefined;
  let baseURL: string | undefined;
  let provider: string | undefined;
  let backend: string | undefined;
  let continueLast = false;
  const extensions: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--model" && argv[i + 1]) model = argv[++i];
    else if (a === "--api-key" && argv[i + 1]) apiKey = argv[++i];
    else if (a === "--base-url" && argv[i + 1]) baseURL = argv[++i];
    else if (a === "--provider" && argv[i + 1]) provider = argv[++i];
    else if (a === "--backend" && argv[i + 1]) backend = argv[++i];
    else if ((a === "-e" || a === "--extensions") && argv[i + 1]) {
      extensions.push(...argv[++i]!.split(",").map(s => s.trim()).filter(Boolean));
    } else if (a === "-c" || a === "--continue") {
      continueLast = true;
    } else if (a === "-h" || a === "--help") {
      process.stdout.write(MANAGEMENT_HELP + "\n");
      process.exit(0);
    }
  }

  return { shell: "/bin/sh", model, apiKey, baseURL, provider, backend, extensions, continueLast };
}

const MANAGEMENT_HELP = `ashi — ash (agent-sh's built-in agent) in an interactive TUI

Management:
  ashi install <name> [--force]   Install an extension
  ashi uninstall <name>           Remove an installed extension
  ashi list                       List installed extensions
  ashi auth login [provider]      Store an API key
  ashi auth logout <provider>     Remove a stored key
  ashi auth list                  Show configured providers
  ashi init [--force]             Scaffold ~/.agent-sh/ (settings, AGENTS.md)

Launch (default):
  ashi [--provider <name>] [--model <id>] [--api-key <key>] [--base-url <url>]
       [--backend <name>] [-e <ext>[,<ext>...]] [-c | --continue]

  -c, --continue   Resume the last session in this cwd (fresh session if none)

Reads ~/.agent-sh/settings.json for providers and defaults.`;

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  const sub = rawArgs[0];
  const rest = rawArgs.slice(1);

  if (sub === "install" || sub === "uninstall" || sub === "list") {
    const { runInstall, runUninstall, runList } = await import("agent-sh/cli/install");
    if (sub === "install") await runInstall(rest[0] ?? "", {
      force: rest.includes("--force"),
      syncDeps: rest.includes("--sync-deps"),
    });
    else if (sub === "uninstall") await runUninstall(rest[0] ?? "");
    else runList();
    process.exit(0);
  }
  if (sub === "auth") {
    const { runAuth } = await import("agent-sh/cli/auth");
    await runAuth(rest);
    process.exit(0);
  }
  if (sub === "init") {
    const { runInit } = await import("agent-sh/cli/init");
    runInit({ force: rest.includes("--force") });
    process.exit(0);
  }
  if (sub === "--help" || sub === "-h") {
    process.stdout.write(MANAGEMENT_HELP + "\n");
    process.exit(0);
  }
  if (sub && !sub.startsWith("-")) {
    process.stderr.write(`ashi: unknown subcommand "${sub}".\n`);
    process.stderr.write("Available: install, uninstall, list, auth, init\n");
    process.stderr.write("Run `ashi --help` for details.\n");
    process.exit(1);
  }

  const config = parseArgs(rawArgs);

  if (!process.stdin.isTTY) {
    process.stderr.write("ashi requires a TTY for interactive rendering.\n");
    process.exit(1);
  }

  const cwd = process.cwd();
  const cwdSlug = cwd.replace(/\//g, "-").replace(/^-/, "");
  const sessionsDir = path.join(os.homedir(), ".agent-sh", "ashi", "history", cwdSlug, "sessions");
  const resumeId = config.continueLast
    ? MultiSessionStore.readLastSessionId(sessionsDir, { fallbackToLatest: true })
    : undefined;
  const store = new MultiSessionStore(sessionsDir, cwd, { resumeSessionId: resumeId });
  const getStore = (): MultiSessionStore => store;

  const core = createCore(config);

  let stopFrontend: (() => void) | null = null;

  let shellRef: { kill(): void } | null = null;
  const cleanup = (): void => {
    try { stopFrontend?.(); } catch {}
    try { shellRef?.kill(); } catch {}
    try { core.kill(); } catch {}
    if (process.stdin.isTTY) {
      try { process.stdin.setRawMode(false); } catch {}
    }
    process.exit(0);
  };

  const ctx = core.extensionContext({ quit: cleanup });

  activateAgent(ctx);
  activateShellContext(ctx);
  await loadBuiltinExtensions(ctx, ["rolling-history"]);

  const shell = new Shell({
    bus: core.bus,
    handlers: { define: ctx.define, call: ctx.call },
    cols: 100,
    rows: 30,
    shell: process.env.SHELL ?? "/bin/bash",
    cwd: process.cwd(),
    instanceId: ctx.instanceId,
    terminal: headlessTerminal(),
  });
  shellRef = shell;

  let terminalBuffer: TerminalBuffer | null | undefined;
  ctx.define("terminal-buffer", (): TerminalBuffer | null => {
    if (terminalBuffer !== undefined) return terminalBuffer;
    try {
      terminalBuffer = TerminalBuffer.createWired(core.bus);
    } catch {
      terminalBuffer = null;
    }
    return terminalBuffer;
  });

  const loaded = await loadExtensions(ctx, config.extensions);
  core.bus.emit("core:extensions-loaded", { names: loaded });

  const { names: backendNames } = core.bus.emitPipe("config:get-backends", {
    names: [] as string[], active: null as string | null,
  });
  if (backendNames.length === 0) {
    process.stderr.write("ashi: no agent backend registered. Set OPENAI_API_KEY or OPENROUTER_API_KEY, or configure ~/.agent-sh/settings.json.\n");
    process.exit(1);
  }

  const capture = registerCapture(ctx, getStore);
  registerCompaction(ctx, getStore, capture);

  // Renderers are extensions: ashi registers the built-in pi-tui renderer, and
  // any loaded extension can register its own `ashi:renderer:<name>` (see
  // examples/extensions/ashi-opentui-renderer). ASHI_RENDERER picks one by name.
  ctx.define("ashi:renderer:pi-tui", () => createPiTuiRenderer());
  const rendererName = (process.env.ASHI_RENDERER ?? "pi-tui").trim();
  const rendererKey = `ashi:renderer:${rendererName}`;
  if (!ctx.list().includes(rendererKey)) {
    process.stderr.write(
      `ashi: no renderer registered for "${rendererName}" (${rendererKey}). ` +
      `Load the extension that provides it (e.g. \`ashi -e <renderer-ext>\`), or unset ASHI_RENDERER.\n`,
    );
    process.exit(1);
  }
  const renderer = ctx.call(rendererKey) as Renderer;
  registerRenderDefaults(ctx, renderer);
  registerDefaultSchemaRenderers(ctx);

  ctx.advise("system-prompt:build", (next) => `${next()}\n\n<cwd>${process.cwd()}</cwd>`);

  const handle = mountAshi(ctx, getStore, capture, renderer);
  stopFrontend = handle.stop;

  registerForkCommands(ctx, getStore, handle.openTreePicker, handle.rebuildChat, capture);
  registerSessionCommands(ctx, getStore, capture, {
    openSessionPicker: handle.openSessionPicker,
    rebuildChat: handle.rebuildChat,
  });

  if (resumeId) {
    applyBranchMessages(ctx, getStore, capture);
    await handle.rebuildChat();
    ctx.bus.emit("ui:info", { message: `continued session ${resumeId.slice(0, 12)}…` });
  }

  await core.activateBackend(config.backend ?? getSettings().defaultBackend);

  process.on("SIGTERM", cleanup);
  process.on("SIGHUP", cleanup);
}

main().catch((err) => {
  process.stderr.write(`ashi fatal: ${err?.stack ?? err}\n`);
  process.exit(1);
});
