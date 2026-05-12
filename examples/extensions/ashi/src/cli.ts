#!/usr/bin/env node
/**
 * ashi — agent-sh's ash backend with a pi-tui frontend, no shell.
 *
 * Boots the agent-sh kernel directly, skips the PTY shell and the
 * default streaming tui-renderer, and mounts pi-tui as the sole
 * frontend. Demonstrates that the kernel is frontend-agnostic — same
 * backend, tools, slash commands, providers; different presentation.
 */
import { createCore } from "agent-sh/core";
import { loadBuiltinExtensions } from "agent-sh/extensions";
import { loadExtensions } from "agent-sh/extension-loader";
import { getSettings } from "agent-sh/settings";
import type { AgentShellConfig } from "agent-sh/types";

import { mountAshi } from "./frontend.js";

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

  // shell is required by AgentShellConfig's type but unused without the PTY frontend.
  return { shell: "/bin/sh", model, apiKey, baseURL, provider, backend, extensions };
}

async function main(): Promise<void> {
  // parseArgs handles --help by exiting before we reach the TTY check.
  const config = parseArgs(process.argv.slice(2));

  if (!process.stdin.isTTY) {
    process.stderr.write("ashi requires a TTY for interactive rendering.\n");
    process.exit(1);
  }
  const core = createCore(config);

  // Built by frontend.ts; declared up here so cleanup can reach it.
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

  // Skip shell-context (no PTY → no cwd tracking via shell events; core's
  // process.cwd() default is fine), the default streaming tui-renderer
  // (pi-tui replaces it), and file-autocomplete (it advises the shell's
  // input handler, which doesn't exist here).
  const disabled = ["shell-context", "tui-renderer", "file-autocomplete"];
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

  const handle = mountAshi(ctx);
  stopFrontend = handle.stop;

  await core.activateBackend(config.backend ?? getSettings().defaultBackend);

  process.on("SIGTERM", cleanup);
  process.on("SIGHUP", cleanup);
}

main().catch((err) => {
  process.stderr.write(`ashi fatal: ${err?.stack ?? err}\n`);
  process.exit(1);
});
