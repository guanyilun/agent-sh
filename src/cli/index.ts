#!/usr/bin/env node
import { activateShell, registerShellHandlers, type ShellHandle } from "../shell/index.js";
import { activateAgent } from "../agent/index.js";
import { createCore } from "../core/index.js";
import { palette as p } from "../utils/palette.js";
import { loadBuiltinExtensions } from "../extensions/index.js";
import { loadExtensions } from "../core/extension-loader.js";
import { getSettings } from "../core/settings.js";
import { dispatchSubcommand } from "./subcommands.js";
import { suggestBridgeFor } from "./install.js";
import { anyProviderConfigured } from "./auth/keys.js";
import { clearOpost } from "../utils/tty.js";
import { parseArgs } from "./args.js";
import { captureShellEnvAsync, mergeShellEnv } from "./shell-env.js";

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  if (await dispatchSubcommand(rawArgs)) return;

  if (process.env.AGENT_SH) {
    console.error("agent-sh: already running inside an agent-sh session (nested sessions are not supported).");
    process.exit(1);
  }

  process.on("SIGTTOU", () => {});
  process.on("SIGTTIN", () => {});

  const config = parseArgs(rawArgs);

  // Capture user's full shell environment
  const baseEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) baseEnv[k] = v;
  }

  const shellPath = config.shell || process.env.SHELL || "/bin/bash";
  try {
    const shellEnv = await captureShellEnvAsync(shellPath);
    if (Object.keys(shellEnv).length > 0) {
      Object.assign(baseEnv, mergeShellEnv(baseEnv, shellEnv));
      // Expose captured env vars to process.env so extensions can read them.
      // Only add vars not already present to avoid clobbering runtime state.
      for (const [k, v] of Object.entries(baseEnv)) {
        if (process.env[k] === undefined) {
          process.env[k] = v;
        }
      }
      if (process.env.DEBUG) {
        console.error('[agent-sh] Shell environment captured');
      }
    }
  } catch {
    // Ignore errors, we already have process.env as fallback
  }

  const selectedBackend = config.backend ?? getSettings().defaultBackend ?? "ash";
  if (selectedBackend === "ash" && !config.apiKey && !config.provider && !anyProviderConfigured()) {
    console.error(
      "\nagent-sh: no LLM provider configured.\n\n" +
      "  Run `agent-sh auth login` to store an API key, or\n" +
      "  export OPENAI_API_KEY / OPENROUTER_API_KEY / DEEPSEEK_API_KEY, or\n" +
      "  run `agent-sh init` for a settings.json template.\n",
    );
    process.exit(1);
  }

  // ── Core (frontend-agnostic) ──────────────────────────────────
  const core = createCore(config);
  const { bus } = core;

  // Track agent info from bus events (populated by extension backends)
  let agentInfo: { name: string; version: string; model?: string; provider?: string } | null = null;
  bus.on("agent:info", (info) => { agentInfo = info; });

  // ── Interactive frontend ──────────────────────────────────────
  if (process.env.DEBUG) {
    console.error('[agent-sh] Setting up interactive frontend...');
  }
  process.stdout.write(`\x1b]0;agent-sh\x07`);

  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;

  // Bound after activateShell — cleanup is wired into extCtx.quit before the
  // shell exists, so the closure captures the var by reference.
  let shell: ShellHandle | null = null;

  const cleanup = () => {
    core.kill();
    shell?.kill();
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    process.exit(0);
  };

  const extCtx = core.extensionContext({ quit: cleanup });

  // Before loadExtensions: extensions look up shell handlers at activation.
  registerShellHandlers(extCtx);
  activateAgent(extCtx);

  // Load before spawning the shell so PS1 lands below the banner.
  await loadBuiltinExtensions(extCtx, getSettings().disabledBuiltins);
  const loadExtensionsTimeoutMs = 10000;
  let loadedExtensions: string[] = [];
  await Promise.race([
    loadExtensions(extCtx, config.extensions).then((names) => { loadedExtensions = names; }),
    new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error(`Extension loading timeout after ${loadExtensionsTimeoutMs}ms`)), loadExtensionsTimeoutMs)
    ),
  ]).catch((err) => {
    console.error(`Warning: ${err.message}`);
  });
  core.bus.emit("core:extensions-loaded", { names: loadedExtensions });

  const { names: backendNames } = core.bus.emitPipe("config:get-backends", { names: [] as string[], active: null as string | null });
  if (backendNames.length === 0) {
    console.error("\nagent-sh: no agent backend available.\n\n" +
      "  Export OPENROUTER_API_KEY or OPENAI_API_KEY for zero-config launch, or\n" +
      "  pass --api-key on the command line, or\n" +
      "  run `agent-sh init` for a settings.json template, or\n" +
      "  run `agent-sh install <bridge>` (e.g. pi-bridge, claude-code-bridge) to use a non-ash backend.\n");
    process.exit(1);
  }
  if (config.backend && !backendNames.includes(config.backend)) {
    const bridge = suggestBridgeFor(config.backend);
    const hint = bridge
      ? `  Try: agent-sh install ${bridge}\n`
      : `  Run \`agent-sh install\` to see bundled bridge extensions.\n`;
    console.error(`\nagent-sh: backend "${config.backend}" is not available.\n\n` +
      `  Available backends: ${backendNames.join(", ")}\n` +
      hint);
    process.exit(1);
  }

  const settings = getSettings();
  if (settings.startupBanner !== false) {
    const termW = process.stdout.columns || 80;
    const bannerW = Math.min(termW, 60);

    const productName = `${p.accent}${p.bold}agent-sh${p.reset}`;

    const backendName = config.backend && backendNames.includes(config.backend)
      ? config.backend
      : settings.defaultBackend && backendNames.includes(settings.defaultBackend)
      ? settings.defaultBackend
      : backendNames[0]!;

    let sections = "";
    sections += `\n\n  ${p.muted}Backend:${p.reset} ${p.dim}${backendName}${p.reset}`;

    const extSections = bus.emitPipe("banner:collect", { sections: [], activeBackend: backendName }).sections;
    for (const sec of extSections) {
      sections += `\n\n  ${p.muted}${sec.label}:${p.reset}`;
      for (const item of sec.items) {
        sections += `\n    ${p.dim}${item}${p.reset}`;
      }
    }

    const hint = `${p.muted}Type ${p.warning}>${p.muted} to ask AI · ${p.warning}>/help${p.muted} for commands${p.reset}`;
    const borderLine = `${p.muted}${"─".repeat(bannerW)}${p.reset}`;

    process.stdout.write(
      "\n" + borderLine + "\n" +
      "  " + productName +
      sections + "\n" +
      "\n  " + hint + "\n" +
      borderLine + "\n\n",
    );
  }

  await core.activateBackend(config.backend);

  // 100ms sidesteps macOS SIGTTOU during fg-pgrp handoff.
  await new Promise(resolve => setTimeout(resolve, 100));
  shell = activateShell(extCtx, {
    cols,
    rows,
    shellPath: config.shell || process.env.SHELL || "/bin/bash",
    cwd: process.cwd(),
    onShowAgentInfo: () => {
      if (agentInfo) {
        return { info: `${p.dim}${agentInfo.name}${agentInfo.model ? ` (${agentInfo.model})` : ""}${p.reset}` };
      }
      return { info: "" };
    },
  });

  bus.emit("input-mode:register", {
    id: "agent",
    trigger: ">",
    label: "agent",
    promptIcon: "❯",
    indicator: "●",
    onSubmit(query, b) {
      b.emit("agent:submit", { query });
    },
    returnToSelf: true,
  });

  // ── Terminal lifecycle ────────────────────────────────────────
  process.on("SIGTERM", cleanup);
  process.on("SIGHUP", cleanup);

  process.on("SIGTSTP", () => {
    if (process.stdin.isTTY) {
      try {
        process.stdin.setRawMode(false);
      } catch {
        // Ignore
      }
    }
    process.kill(process.pid!, "SIGSTOP");
  });

  process.on("SIGCONT", () => {
    if (process.stdin.isTTY) {
      try {
        process.stdin.setRawMode(true);
        clearOpost();
      } catch {
        // May fail if stdin is not a TTY
      }
    }
  });

  // resize forwarding is set up inside activateShell; nothing to wire here.

  shell!.onExit((e) => {
    core.kill();
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    process.exit(e.exitCode);
  });

  if (process.env.DEBUG) {
    console.error('[agent-sh] Resuming stdin...');
  }
  process.stdin.resume();

  if (process.stdin.isTTY) {
    if (process.env.DEBUG) {
      console.error('[agent-sh] Setting raw mode...');
    }
    setImmediate(() => {
      try {
        process.stdin.setRawMode(true);
        if (process.env.DEBUG) {
          console.error('[agent-sh] Raw mode enabled');
        }
      } catch (err) {
        if (process.env.DEBUG) {
          console.error(`[agent-sh] Failed to set raw mode: ${err}`);
        }
      }
    });
  }
  if (process.env.DEBUG) {
    console.error('[agent-sh] Startup complete');
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
