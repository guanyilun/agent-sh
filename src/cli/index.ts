#!/usr/bin/env node
import { activateShell, registerShellHandlers, type ShellHandle } from "../shell/index.js";
import { activateAgent } from "../agent/index.js";
import { createCore } from "../core/index.js";
import { palette as p } from "../utils/palette.js";
import activateRollingHistory from "../agent/extensions/rolling-history/index.js";
import { getSettings } from "../core/settings.js";
import { dispatchSubcommand } from "./subcommands.js";
import { anyProviderConfigured, KNOWN_PROVIDERS } from "./auth/keys.js";
import { clearOpost } from "../utils/tty.js";
import { parseArgs } from "./args.js";
import { captureShellEnvAsync, mergeShellEnv } from "./shell-env.js";
import { loadAllExtensions, requireBackends } from "./boot.js";
import { runHeadless } from "./headless.js";

declare module "../core/event-bus.js" {
  interface BusEvents {
    /** Startup banner collection (sync pipe). Extensions contribute
     *  labeled item lists; the CLI renders them between the product
     *  name and the help hint. */
    "banner:collect": {
      sections: Array<{ label: string; items: string[] }>;
      /** Name of the backend being launched. Extensions should gate
       *  per-backend sections on this rather than settings.defaultBackend. */
      activeBackend?: string;
    };
  }
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  if (await dispatchSubcommand(rawArgs)) return;

  const config = parseArgs(rawArgs);
  const headless = config.print !== undefined;

  // Headless runs spawn no shell, so they're safe inside an agent-sh session.
  if (process.env.AGENT_SH && !headless) {
    console.error("agent-sh: already running inside an agent-sh session (nested sessions are not supported).");
    process.exit(1);
  }

  process.on("SIGTTOU", () => {});
  process.on("SIGTTIN", () => {});

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
    const envVars = KNOWN_PROVIDERS
      .map((p) => p.envVar)
      .filter((v): v is string => Boolean(v))
      .join(" / ");
    console.error(
      "\nagent-sh: no LLM provider configured.\n\n" +
      "  Run `agent-sh auth login` to store an API key, or\n" +
      `  export ${envVars}, or\n` +
      "  run `agent-sh init` for a settings.json template.\n",
    );
    process.exit(1);
  }

  if (headless) await runHeadless(config);

  // ── Core (frontend-agnostic) ──────────────────────────────────
  const core = createCore(config);
  const { bus } = core;

  let agentInfo: { name: string; version: string; model?: string; provider?: string } | null = null;
  bus.on("agent:info", (info) => {
    agentInfo = info;
    // Redraw so late agent:info emits (opencode-bridge after session.create) reach the prompt.
    bus.emit("config:changed", {});
  });

  // tui-renderer subscribes to ui:error inside activateShell, after backend
  // activation — pipe to stderr until the shell is up so boot failures surface.
  const bootUiError = (e: { message: string }) => {
    process.stderr.write(`agent-sh: ${e.message}\n`);
  };
  bus.on("ui:error", bootUiError);

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
  const settings = getSettings();
  await loadAllExtensions(extCtx, config.extensions);
  const backendNames = requireBackends(core, config.backend);

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
  activateRollingHistory(extCtx);

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
  bus.off("ui:error", bootUiError);

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
