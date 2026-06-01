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

interface CacheProbe {
  model: string;
  result: number | undefined;
  found: boolean;
}

interface DriverResult {
  events: CapturedEvent[];
  models?: any[];
  cacheProbes?: CacheProbe[];
  stderr: string;
  stdout: string;
  exitCode: number | null;
}

async function runDriver(
  settings: Record<string, unknown>,
  scenario: { config?: Record<string, unknown>; capture: string[]; dumpModels?: boolean; probeCacheTokens?: unknown[]; steps: unknown[] },
  envOverride: Record<string, string> = {},
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
            ...envOverride,
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
          const parsed = JSON.parse(line) as { events: CapturedEvent[]; models?: any[]; cacheProbes?: CacheProbe[] };
          resolve({ events: parsed.events, models: parsed.models, cacheProbes: parsed.cacheProbes, stderr, stdout, exitCode: code });
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
    dumpModels: true,
    capture: ["agent:models-changed"],
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

  const models = result.models!;
  assert.deepEqual(
    models.map((m) => m.id),
    ["settings/m1", "settings/m2"],
    "settings.models replaces payload models when modelsExplicit",
  );

  for (const m of models) {
    assert.equal(m.provider, "openrouter");
    assert.equal(m.endpoint.apiKey, "sk-from-settings", `apiKey override on model ${m.id}`);
    assert.equal(m.endpoint.baseURL, "https://settings.example", `baseURL override on model ${m.id}`);
  }

  const m2 = models.find((m) => m.id === "settings/m2")!;
  assert.equal(m2.contextWindow, 99999, "settings modelCapabilities overlay");
  const m1 = models.find((m) => m.id === "settings/m1")!;
  assert.equal(m1.contextWindow, undefined, "no caps when neither settings nor payload supply them");
});

test("active mode missing from refreshed catalog stays as ghost + emits ui:info toast", async () => {
  const settings = {
    defaultProvider: "openrouter",
    providers: {
      openrouter: { apiKey: "x", baseURL: "https://openrouter.ai/api/v1", defaultModel: "m-b" },
    },
  };

  const result = await runDriver(settings, {
    dumpModels: true,
    capture: ["agent:info", "ui:info", "agent:models-changed"],
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
    result.models!.map((m) => m.id),
    ["m-a", "m-c"],
    "agent:get-models reflects the refreshed catalog (ghost lives in AgentLoop)",
  );
});

test("persisted default not in initial catalog → stub used as initial active mode", async () => {
  const settings = {
    defaultProvider: "openrouter",
    providers: { openrouter: { apiKey: "x", baseURL: "https://openrouter.ai/api/v1", defaultModel: "future/model" } },
  };

  const result = await runDriver(settings, {
    dumpModels: true,
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

  assert.deepEqual(result.models!.map((m) => m.id), ["existing/m1"], "registry has only the real catalog");
});

test("late catalog containing persisted default does not switch away from active override", async () => {
  const settings = {
    defaultProvider: "openrouter",
    providers: { openrouter: { apiKey: "x", baseURL: "https://openrouter.ai/api/v1", defaultModel: "persisted/m" } },
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

test("default mode cache extractor reads OpenAI-standard prompt_tokens_details.cached_tokens", async () => {
  const settings = {
    providers: { openrouter: { apiKey: "x", baseURL: "https://openrouter.ai/api/v1" } },
  };

  const result = await runDriver(settings, {
    capture: [],
    probeCacheTokens: [
      { model: "std/m", usage: { prompt_tokens: 200, prompt_tokens_details: { cached_tokens: 120 } } },
      { model: "std/m", usage: { prompt_tokens: 200 } },
    ],
    steps: [
      { kind: "providers.register", payload: { id: "openrouter", apiKey: "x", defaultModel: "std/m", models: ["std/m"] } },
    ],
  });

  const probes = result.cacheProbes!;
  assert.ok(probes[0].found, "openrouter mode std/m should exist");
  assert.equal(probes[0].result, 120, "cached_tokens flows through the default extractor");
  assert.equal(probes[1].result, undefined, "no cached_tokens field → undefined (no cache chip)");
});

test("native DeepSeek's flat hit count overrides the default cache extractor", async () => {
  const result = await runDriver(
    {},
    {
      capture: [],
      probeCacheTokens: [
        { model: "deepseek-v4-flash", usage: { prompt_tokens: 200, prompt_cache_hit_tokens: 80, prompt_cache_miss_tokens: 120 } },
        { model: "deepseek-v4-flash", usage: { prompt_tokens: 200, prompt_tokens_details: { cached_tokens: 50 } } },
      ],
      steps: [{ kind: "activate-provider", name: "deepseek" }],
    },
    { DEEPSEEK_API_KEY: "sk-test" },
  );

  const probes = result.cacheProbes!;
  assert.ok(probes[0].found, "deepseek mode should be built when DEEPSEEK_API_KEY is set");
  assert.equal(probes[0].result, 80, "flat prompt_cache_hit_tokens used as the cached count");
  assert.equal(probes[1].result, undefined, "deepseek hook ignores the OpenAI-standard shape");
});
