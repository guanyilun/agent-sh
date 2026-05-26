/** Locks in four behaviors of agent/index.ts + agent-loop.ts:
 *  settings overlay, ghost preservation, persisted-default stub, late reconcile. */
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

test("settings.json apiKey/baseURL/defaultModel and modelsExplicit override registered payload", async () => {
  const settings = {
    providers: {
      openrouter: {
        apiKey: "sk-from-settings",
        baseURL: "https://settings.example",
        defaultModel: "settings/default",
        // Array literal flips modelsExplicit on.
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
  assert.equal(m1.contextWindow, undefined, "no caps when neither settings nor payload supply them");
});

test("active mode missing from refreshed catalog stays as ghost + emits ui:info toast", async () => {
  const settings = {
    defaultProvider: "openrouter",
    providers: {
      openrouter: { apiKey: "x", defaultModel: "m-b" },
    },
  };

  const result = await runDriver(settings, {
    dumpModes: true,
    capture: ["agent:info", "ui:info", "agent:modes-changed"],
    steps: [
      { kind: "providers.register", payload: { id: "openrouter", apiKey: "x", defaultModel: "m-a", models: ["m-a", "m-b"] } },
      { kind: "core:extensions-loaded" },
      { kind: "activate-backend", name: "ash" },
      { kind: "providers.register", payload: { id: "openrouter", apiKey: "x", defaultModel: "m-a", models: ["m-a", "m-c"] } },
      { kind: "wait" },
    ],
  });

  const infos = pickEvents(result.events, "agent:info");
  assert.ok(infos.length >= 1);
  assert.equal(infos[0].model, "m-b", "boot identity should be m-b");

  const toasts = pickEvents(result.events, "ui:info").map((p) => p.message);
  const ghost = toasts.find((m) => m.includes("openrouter:m-b") && m.includes("not in the refreshed catalog"));
  assert.ok(ghost, `expected ghost ui:info, got: ${JSON.stringify(toasts)}`);

  assert.equal(infos[infos.length - 1].model, "m-b", "active model preserved across refresh");

  assert.deepEqual(
    result.modes!.map((m) => m.model),
    ["m-a", "m-c"],
    "agent:get-modes reflects the refreshed catalog (ghost lives in AgentLoop)",
  );
});

test("persisted default not in initial catalog → stub used as initial active mode", async () => {
  const settings = {
    defaultProvider: "openrouter",
    providers: { openrouter: { apiKey: "x", defaultModel: "future/model" } },
  };

  const result = await runDriver(settings, {
    dumpModes: true,
    capture: ["agent:info"],
    steps: [
      { kind: "providers.register", payload: { id: "openrouter", apiKey: "x", defaultModel: "existing/default", models: ["existing/m1"] } },
      { kind: "core:extensions-loaded" },
      { kind: "activate-backend", name: "ash" },
    ],
  });

  const infos = pickEvents(result.events, "agent:info");
  assert.ok(infos.length >= 1);
  assert.equal(infos[0].model, "future/model", "boot active model is the persisted stub");
  assert.equal(infos[0].provider, "openrouter");
  assert.equal(infos[0].contextWindow, undefined, "stub has no contextWindow");

  assert.deepEqual(result.modes!.map((m) => m.model), ["existing/m1"], "registry has only the real catalog");
});

test("late catalog containing persisted default does not switch away from active override", async () => {
  const settings = {
    defaultProvider: "openrouter",
    providers: { openrouter: { apiKey: "x", defaultModel: "persisted/m" } },
  };

  const result = await runDriver(settings, {
    config: { model: "override/m" },
    capture: ["config:switch-model", "agent:info"],
    steps: [
      { kind: "providers.register", payload: { id: "openrouter", apiKey: "x", defaultModel: "override/m", models: ["override/m"] } },
      { kind: "core:extensions-loaded" },
      { kind: "activate-backend", name: "ash" },
      { kind: "providers.register", payload: { id: "openrouter", apiKey: "x", defaultModel: "override/m", models: ["override/m", "persisted/m"] } },
      { kind: "wait" },
    ],
  });

  const switches = pickEvents(result.events, "config:switch-model");
  assert.equal(switches.length, 0, `expected no config:switch-model; got ${JSON.stringify(switches)}`);

  const infos = pickEvents(result.events, "agent:info");
  assert.equal(infos[infos.length - 1].model, "override/m", "active model stays on the override");
});
