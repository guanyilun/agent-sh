#!/usr/bin/env node
import { spawn } from "node:child_process";
import * as path from "node:path";
import { activateShell, registerShellHandlers, type ShellHandle } from "./shell/index.js";
import { createCore } from "./core.js";
import { palette as p } from "./utils/palette.js";
import { loadBuiltinExtensions } from "./extensions/index.js";
import { loadExtensions } from "./extension-loader.js";
import { getSettings } from "./settings.js";
import { runInit } from "./init.js";
import { runInstall, runUninstall, runList, suggestBridgeFor } from "./install.js";
import { PACKAGE_VERSION } from "./utils/package-version.js";
import type { AgentShellConfig } from "./types.js";

/**
 * Capture the user's full shell environment.
 * This picks up env vars exported in .zshrc/.bashrc that the
 * Node.js process doesn't have (e.g. when launched from an IDE).
 */
async function captureShellEnvAsync(shell: string): Promise<Record<string, string>> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (result: Record<string, string>): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    try {
      const shellName = path.basename(shell);
      const isZsh = shellName.includes("zsh");
      const sourceRc = isZsh
        ? 'source ~/.zshrc 2>/dev/null;'
        : '[ -f ~/.bashrc ] && source ~/.bashrc 2>/dev/null;';

      const child = spawn(shell, ["-l", "-c", `${sourceRc} env -0`], {
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5000,
      });

      let output = "";
      child.stdout?.on("data", (data) => {
        output += data.toString("utf-8");
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0 || !output) {
          done({});
          return;
        }
        const env: Record<string, string> = {};
        for (const entry of output.split("\0")) {
          const eq = entry.indexOf("=");
          if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1);
        }
        done(env);
      });

      child.on("error", () => {
        clearTimeout(timer);
        done({});
      });

      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        done({});
      }, 5000);
    } catch {
      done({});
    }
  });
}

function mergeShellEnv(baseEnv: Record<string, string>, shellEnv: Record<string, string>): Record<string, string> {
  const merged = { ...baseEnv };
  for (const [key, value] of Object.entries(shellEnv)) {
    if (!(key in merged) || !merged[key]) {
      merged[key] = value;
    }
  }
  return merged;
}

function parseArgs(argv: string[]): AgentShellConfig {
  let model: string | undefined;
  let extensions: string[] | undefined;
  let provider: string | undefined;
  let backend: string | undefined;
  let shell = process.env.SHELL || "/bin/bash";

  let apiKey: string | undefined = process.env.OPENAI_API_KEY;
  let baseURL: string | undefined = process.env.OPENAI_BASE_URL;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--model" && argv[i + 1]) {
      model = argv[++i]!;
    } else if (arg === "--api-key" && argv[i + 1]) {
      apiKey = argv[++i]!;
    } else if (arg === "--base-url" && argv[i + 1]) {
      baseURL = argv[++i]!;
    } else if (arg === "--provider" && argv[i + 1]) {
      provider = argv[++i]!;
    } else if (arg === "--backend" && argv[i + 1]) {
      backend = argv[++i]!;
    } else if (arg === "--shell" && argv[i + 1]) {
      shell = argv[++i]!;
    } else if ((arg === "--extensions" || arg === "-e") && argv[i + 1]) {
      const exts = argv[++i]!.split(",").map(s => s.trim());
      extensions = extensions ? [...extensions, ...exts] : exts;
    } else if (arg === "--version" || arg === "-V") {
      console.log(PACKAGE_VERSION);
      process.exit(0);
    } else if (arg === "--help" || arg === "-h") {
      console.log(`agent-sh — a shell-first terminal where AI is one keystroke away

Usage: agent-sh [options]
       agent-sh init [--force]            Scaffold ~/.agent-sh/ (settings, examples, AGENTS.md)
       agent-sh install <spec> [--force]  Install an extension (bundled name, file:, npm:, github:)
       agent-sh uninstall <name>          Remove an installed extension
       agent-sh list                      List installed extensions

Provider Profiles:
  --provider <name>   Use a provider from ~/.agent-sh/settings.json
  --model <name>      Override default model

Direct LLM API:
  --api-key <key>     API key for OpenAI-compatible provider (or set OPENAI_API_KEY)
  --base-url <url>    Base URL for API (or set OPENAI_BASE_URL)

General Options:
  --backend <name>    Agent backend to launch (e.g. ash, pi); overrides settings.defaultBackend for this session
  --shell <path>      Shell to use (default: $SHELL or /bin/bash)
  -e, --extensions    Extensions to load (comma-separated, repeatable)
  -h, --help          Show this help
  -V, --version       Print version and exit

Environment Variables:
  OPENAI_API_KEY     API key for LLM provider
  OPENAI_BASE_URL    Base URL override (e.g., http://localhost:11434/v1 for Ollama)

Examples:
  # Use a configured provider
  agent-sh --provider openai

  # Direct API access
  agent-sh --api-key "$KEY" --model gpt-4o

  # Local model via Ollama
  agent-sh --base-url http://localhost:11434/v1 --model llama3

Inside the shell:
  Type normally        Commands run in your real shell
  > <query>           Ask the AI agent (it decides how to help)
  > /help             Show available slash commands
  Ctrl-C              Cancel agent response (or signal shell as usual)
`);
      process.exit(0);
    }
  }

  return { shell, model, extensions, apiKey, baseURL, provider, backend };
}

async function main(): Promise<void> {
  // Subcommands — handled before the shell-launch path.
  const rawArgs = process.argv.slice(2);
  if (rawArgs[0] === "init") {
    runInit({ force: rawArgs.includes("--force") });
    return;
  }
  if (rawArgs[0] === "install") {
    await runInstall(rawArgs[1] ?? "", { force: rawArgs.includes("--force") });
    return;
  }
  if (rawArgs[0] === "uninstall") {
    await runUninstall(rawArgs[1] ?? "");
    return;
  }
  if (rawArgs[0] === "list") {
    runList();
    return;
  }

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

  core.activateBackend(config.backend);

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
