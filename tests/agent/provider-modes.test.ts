/**
 * Baseline integration tests for provider/mode resolution in src/agent/index.ts
 * and the surrounding handlers in src/agent/agent-loop.ts.
 *
 * Locks in four subtle behaviors that any refactor toward pull-composition
 * needs to preserve:
 *   1. settings.json override merge (apiKey / baseURL / defaultModel /
 *      modelsExplicit / modelCapabilities all win over the registered payload)
 *   2. ghost preservation when a re-registered catalog drops the active model
 *   3. persisted-default stub used as the initial mode when the catalog
 *      hasn't yet delivered the user's model
 *   4. late-registration reconcile: switch to persisted default when the
 *      catalog finally arrives and the active model differs
 *
 * Each test spawns the provider-mode-driver subprocess with its own
 * AGENT_SH_HOME so the settings module realm is isolated.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const DRIVER = fileURLToPath(new URL("../fixtures/provider-mode-driver.ts", import.meta.url));

interface CapturedEvent {
  event: string;
  payload: any;
}

interface DriverResult {
  events: CapturedEvent[];
  modes?: any[];
  stderr: string;
  stdout: string;
  exitCode: number | null;
}

async function runDriver(
  settings: Record<string, unknown>,
  scenario: { config?: Record<string, unknown>; capture: string[]; dumpModes?: boolean; steps: unknown[] },
): Promise<DriverResult> {
  const home = mkdtempSync(join(tmpdir(), "agent-sh-pmodes-"));
  writeFileSync(join(home, "settings.json"), JSON.stringify(settings, null, 2));
  try {
    return await new Promise<DriverResult>((resolve, reject) => {
      const child = spawn(
        "node",
        ["--import", "tsx", DRIVER, JSON.stringify(scenario)],
        {
          env: {
            PATH: process.env.PATH,
            HOME: home,
            AGENT_SH_HOME: home,
            AGENT_SH_SKIP_SHELL_ENV: "1",
            OPENROUTER_API_KEY: "",
            OPENAI_API_KEY: "",
            DEEPSEEK_API_KEY: "",
            OPENAI_BASE_URL: "",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stdout = "";
      let stderr = "";
      child.stdout!.on("data", (c) => { stdout += c.toString(); });
      child.stderr!.on("data", (c) => { stderr += c.toString(); });
      const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
      child.on("close", (code) => {
        clearTimeout(timer);
        try {
          const line = stdout.trim().split(/\r?\n/).pop() ?? "";
          const parsed = JSON.parse(line) as { events: CapturedEvent[]; modes?: any[] };
          resolve({ events: parsed.events, modes: parsed.modes, stderr, stdout, exitCode: code });
        } catch (err) {
          reject(new Error(`driver output not JSON.\nexit=${code}\nstdout:\n${stdout}\nstderr:\n${stderr}\nparse error: ${(err as Error).message}`));
        }
      });
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function pickEvents(events: CapturedEvent[], name: string): any[] {
  return events.filter((e) => e.event === name).map((e) => e.payload);
}

// ── Test 1: settings.json override merge ────────────────────────────

test("settings.json apiKey/baseURL/defaultModel and modelsExplicit override registered payload", async () => {
  const settings = {
    providers: {
      openrouter: {
        apiKey: "sk-from-settings",
        baseURL: "https://settings.example",
        defaultModel: "settings/default",
        // Array literal → modelsExplicit = true; locks the catalog to this list.
        models: [
          "settings/m1",
          { id: "settings/m2", contextWindow: 99999 },
        ],
      },
    },
  };

  const result = await runDriver(settings, {
    dumpModes: true,
    capture: ["agent:modes-changed"],
    steps: [
      {
        kind: "providers.register",
        payload: {
          id: "openrouter",
          apiKey: "sk-from-payload",
          baseURL: "https://payload.example",
          defaultModel: "payload/default",
          models: [{ id: "payload/m1", contextWindow: 1234 }],
        },
      },
    ],
  });

  // Pulled modes after registration — assert merge result.
  const modes = result.modes!;
  assert.deepEqual(
    modes.map((m) => m.model),
    ["settings/m1", "settings/m2"],
    "settings.models replaces payload models when modelsExplicit",
  );

  for (const m of modes) {
    assert.equal(m.provider, "openrouter");
    assert.equal(m.providerConfig.apiKey, "sk-from-settings", `apiKey override on mode ${m.model}`);
    assert.equal(m.providerConfig.baseURL, "https://settings.example", `baseURL override on mode ${m.model}`);
  }

  const m2 = modes.find((m) => m.model === "settings/m2")!;
  assert.equal(m2.contextWindow, 99999, "settings modelCapabilities overlay");
  const m1 = modes.find((m) => m.model === "settings/m1")!;
  assert.equal(m1.contextWindow, undefined, "no caps when neither settings nor payload supply them for this id");

  // Register fires the providers:changed → agent:modes-changed notification.
  // (agentBackend gates the emit on `resolved`, which only flips at
  // core:extensions-loaded; pre-boot registrations don't notify.)
  // Either zero or one notification is acceptable here — we assert the
  // pulled state is the canonical source.
});

// ── Test 2: ghost preservation across catalog refresh ───────────────

test("active mode missing from refreshed catalog stays as ghost + emits ui:info toast", async () => {
  const settings = {
    defaultProvider: "openrouter",
    providers: {
      // No `models` field → modelsExplicit = false, payload.models wins.
      // defaultModel here drives effectiveModel at boot so we land on m-b.
      openrouter: { apiKey: "x", defaultModel: "m-b" },
    },
  };

  const result = await runDriver(settings, {
    dumpModes: true,
    capture: ["agent:info", "ui:info", "agent:modes-changed"],
    steps: [
      {
        kind: "providers.register",
        payload: {
          id: "openrouter",
          apiKey: "x",
          defaultModel: "m-a",
          models: ["m-a", "m-b"],
        },
      },
      { kind: "core:extensions-loaded" },
      { kind: "activate-backend", name: "ash" },
      // Catalog refresh drops m-b (the active mode).
      {
        kind: "providers.register",
        payload: {
          id: "openrouter",
          apiKey: "x",
          defaultModel: "m-a",
          models: ["m-a", "m-c"],
        },
      },
      { kind: "wait" },
    ],
  });

  // Boot lands on m-b (settings.defaultModel).
  const infos = pickEvents(result.events, "agent:info");
  assert.ok(infos.length >= 1, "expected at least one agent:info");
  assert.equal(infos[0].model, "m-b", "boot identity should be m-b");

  // After catalog refresh, ghost toast emitted.
  const toasts = pickEvents(result.events, "ui:info").map((p) => p.message);
  const ghost = toasts.find((m) => m.includes("openrouter:m-b") && m.includes("not in the refreshed catalog"));
  assert.ok(ghost, `expected ghost ui:info, got toasts: ${JSON.stringify(toasts)}`);

  // Last agent:info still on m-b (ghost preserved as active).
  assert.equal(infos[infos.length - 1].model, "m-b", "active model preserved across refresh");

  // Canonical modes (per agent:get-modes) reflect the new catalog — the
  // ghost lives only in AgentLoop's activeMode, not in the agentBackend
  // registry. config:get-models is what surfaces the ghost to the UI.
  const finalModes = result.modes!;
  assert.deepEqual(
    finalModes.map((m) => m.model),
    ["m-a", "m-c"],
    "agent:get-modes reflects the refreshed catalog (ghost lives in AgentLoop)",
  );
});

// ── Test 3: persisted-default stub at boot ──────────────────────────

test("persisted default not in initial catalog → stub used as initial active mode", async () => {
  const settings = {
    defaultProvider: "openrouter",
    providers: {
      openrouter: { apiKey: "x", defaultModel: "future/model" },
    },
  };

  const result = await runDriver(settings, {
    dumpModes: true,
    capture: ["agent:info"],
    steps: [
      // Initial register: catalog doesn't yet contain future/model.
      {
        kind: "providers.register",
        payload: {
          id: "openrouter",
          apiKey: "x",
          defaultModel: "existing/default",
          models: ["existing/m1"],
        },
      },
      { kind: "core:extensions-loaded" },
      { kind: "activate-backend", name: "ash" },
    ],
  });

  // Initial agent:info — AgentLoop's activeMode set to the stub.
  const infos = pickEvents(result.events, "agent:info");
  assert.ok(infos.length >= 1, "expected initial agent:info");
  assert.equal(infos[0].model, "future/model", "boot active model is the persisted stub");
  assert.equal(infos[0].provider, "openrouter");
  // Stub carries no contextWindow (the catalog hasn't delivered metadata).
  assert.equal(infos[0].contextWindow, undefined, "stub has no contextWindow");

  // agent:get-modes returns only the real catalog (no stub) — the stub
  // lives in AgentLoop, not in the registry.
  const modes = result.modes!;
  assert.deepEqual(modes.map((m) => m.model), ["existing/m1"], "registry has only the real catalog");
});

// ── Test 4: late-registration reconcile ─────────────────────────────

test("late catalog containing persisted default emits config:switch-model when active differs", async () => {
  const settings = {
    defaultProvider: "openrouter",
    providers: {
      openrouter: { apiKey: "x", defaultModel: "persisted/m" },
    },
  };

  const result = await runDriver(settings, {
    // config.model forces llmClient onto "override/m" at boot so the
    // reconcile condition (llmClient.model !== pendingModel) is met when
    // the catalog later delivers "persisted/m".
    config: { model: "override/m" },
    capture: ["config:switch-model", "agent:modes-changed"],
    steps: [
      {
        kind: "providers.register",
        payload: {
          id: "openrouter",
          apiKey: "x",
          defaultModel: "override/m",
          models: ["override/m"],
        },
      },
      { kind: "core:extensions-loaded" },
      { kind: "activate-backend", name: "ash" },
      // Late catalog arrives with persisted/m in it.
      {
        kind: "providers.register",
        payload: {
          id: "openrouter",
          apiKey: "x",
          defaultModel: "override/m",
          models: ["override/m", "persisted/m"],
        },
      },
      { kind: "wait" },
    ],
  });

  const switches = pickEvents(result.events, "config:switch-model");
  assert.equal(switches.length, 1, `expected one config:switch-model; got ${JSON.stringify(switches)}`);
  assert.equal(switches[0].model, "persisted/m", "switch payload carries model id only (no provider hint)");
});
