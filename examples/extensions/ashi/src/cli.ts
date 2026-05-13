#!/usr/bin/env node
/**
 * ashi — agent-sh's ash backend with a pi-tui frontend, no shell.
 *
 * Boots the agent-sh kernel directly, skips the PTY shell and the
 * default streaming tui-renderer, and mounts pi-tui as the sole
 * frontend. Demonstrates that the kernel is frontend-agnostic — same
 * backend, tools, slash commands, providers; different presentation.
 */
import { createCore, NoopHistory } from "agent-sh/core";
import { loadBuiltinExtensions } from "agent-sh/extensions";
import { loadExtensions } from "agent-sh/extension-loader";
import { getSettings } from "agent-sh/settings";
import type { AgentShellConfig } from "agent-sh/types";

import { mountAshi } from "./frontend.js";
import { MultiSessionStore } from "./multi-session-store.js";
import { registerForkCommands } from "./commands.js";
import { registerSessionCommands } from "./session-commands.js";
import { registerCompaction } from "./compaction.js";
import { registerCapture } from "./capture.js";
import { registerRenderDefaults } from "./hooks.js";
import * as os from "node:os";
import * as path from "node:path";

function parseArgs(argv: string[]): AgentShellConfig & { extensions?: string[] } {
  let model: string | undefined;
  let apiKey: string | undefined = process.env.OPENAI_API_KEY ?? process.env.OPENROUTER_API_KEY;
  let baseURL: string | undefined = process.env.OPENAI_BASE_URL;
  let provider: string | undefined;
  let backend: string | undefined;
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
    } else if (a === "-h" || a === "--help") {
      process.stdout.write(`ashi — ash backend, pi-tui frontend\n\n` +
        `Usage: ashi [--provider <name>] [--model <id>] [--api-key <key>] [--base-url <url>]\n` +
        `            [--backend <name>] [-e <ext>[,<ext>...]]\n\n` +
        `Reads ~/.agent-sh/settings.json for providers and defaults.\n`);
      process.exit(0);
    }
  }

  return { shell: "/bin/sh", model, apiKey, baseURL, provider, backend, extensions };
}

async function main(): Promise<void> {
  const config = parseArgs(process.argv.slice(2));

  if (!process.stdin.isTTY) {
    process.stderr.write("ashi requires a TTY for interactive rendering.\n");
    process.exit(1);
  }

  const cwd = process.cwd();
  const cwdSlug = cwd.replace(/\//g, "-").replace(/^-/, "");
  const sessionsDir = path.join(os.homedir(), ".agent-sh", "ashi", "history", cwdSlug, "sessions");
  const store = new MultiSessionStore(sessionsDir, cwd);
  const getStore = (): MultiSessionStore => store;

  const core = createCore({ ...config, history: new NoopHistory() });

  let stopFrontend: (() => void) | null = null;

  const cleanup = (): void => {
    try { stopFrontend?.(); } catch { /* ignore */ }
    try { core.kill(); } catch { /* ignore */ }
    if (process.stdin.isTTY) {
      try { process.stdin.setRawMode(false); } catch { /* ignore */ }
    }
    process.exit(0);
  };

  const ctx = core.extensionContext({ quit: cleanup });

  const disabled = ["shell-context", "tui-renderer"];
  await loadBuiltinExtensions(ctx, disabled);

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
  registerRenderDefaults(ctx);

  ctx.advise("conversation:format-prior-history", () => null);
  ctx.advise("system-prompt:build", (base) => `${base}\n\n<cwd>${process.cwd()}</cwd>`);

  const handle = mountAshi(ctx, getStore, capture);
  stopFrontend = handle.stop;

  registerForkCommands(ctx, getStore, handle.openTreePicker, handle.rebuildChat, capture);
  registerSessionCommands(ctx, getStore, capture, {
    openSessionPicker: handle.openSessionPicker,
    rebuildChat: handle.rebuildChat,
  });

  await core.activateBackend(config.backend ?? getSettings().defaultBackend);

  process.on("SIGTERM", cleanup);
  process.on("SIGHUP", cleanup);
}

main().catch((err) => {
  process.stderr.write(`ashi fatal: ${err?.stack ?? err}\n`);
  process.exit(1);
});
