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

interface HeaderProbe {
  model: string;
  found: boolean;
  headers: Record<string, string> | undefined;
}

interface DriverResult {
  events: CapturedEvent[];
  models?: any[];
  cacheProbes?: CacheProbe[];
  headerProbes?: HeaderProbe[];
  llmClient?: { enabled: boolean; apiKey: string };
  thinking?: { level: string; levels: string[]; supported: boolean; model: string; params?: Record<string, unknown> };
  stderr: string;
  stdout: string;
  exitCode: number | null;
}

async function runDriver(
  settings: Record<string, unknown>,
  scenario: { config?: Record<string, unknown>; capture: string[]; dumpModels?: boolean; probeCacheTokens?: unknown[]; probeRequestHeaders?: unknown[]; probeLlmClient?: boolean; probeThinking?: boolean; steps: unknown[] },
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
          const parsed = JSON.parse(line) as { events: CapturedEvent[]; models?: any[]; cacheProbes?: CacheProbe[]; headerProbes?: HeaderProbe[]; llmClient?: { enabled: boolean; apiKey: string }; thinking?: DriverResult["thinking"] };
          resolve({ events: parsed.events, models: parsed.models, cacheProbes: parsed.cacheProbes, headerProbes: parsed.headerProbes, llmClient: parsed.llmClient, thinking: parsed.thinking, stderr, stdout, exitCode: code });
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

test("openrouter attaches x-session-id only when a session id is present", async () => {
  // activate-provider installs the requestHeaders configure hook (keyed on the
  // "openrouter" provider id, independent of catalog registration); the explicit
  // register gives the model an apiKey so it surfaces in agent:get-models.
  const result = await runDriver({}, {
    capture: [],
    probeRequestHeaders: [
      { model: "or/m", sessionId: "sess-abc" },
      { model: "or/m" },
    ],
    steps: [
      { kind: "activate-provider", name: "openrouter" },
      { kind: "providers.register", payload: { id: "openrouter", apiKey: "x", baseURL: "https://openrouter.ai/api/v1", defaultModel: "or/m", models: ["or/m"] } },
    ],
  });

  const probes = result.headerProbes!;
  assert.ok(probes[0].found, "registered openrouter model should exist");
  assert.deepEqual(probes[0].headers, { "x-session-id": "sess-abc" }, "session id flows into the sticky-routing header");
  assert.deepEqual(probes[1].headers, {}, "no session id → no header attached");
});

test("non-openrouter providers register no request-headers hook", async () => {
  const result = await runDriver(
    {},
    {
      capture: [],
      probeRequestHeaders: [{ model: "deepseek-v4-flash", sessionId: "sess-abc" }],
      steps: [{ kind: "activate-provider", name: "deepseek" }],
    },
    { DEEPSEEK_API_KEY: "sk-test" },
  );

  const probes = result.headerProbes!;
  assert.ok(probes[0].found, "deepseek model should exist");
  assert.equal(probes[0].headers, undefined, "deepseek configures no requestHeaders hook, so no header is built");
});

test("--model alone starts on a provider that offers it, not the default", async () => {
  const result = await runDriver({ defaultProvider: "p1" }, {
    config: { model: "only-in-p2" },
    capture: ["agent:info", "ui:error"],
    steps: [
      { kind: "providers.register", payload: { id: "p1", apiKey: "k1", baseURL: "https://p1.local/v1", models: ["m1"] } },
      { kind: "providers.register", payload: { id: "p2", apiKey: "k2", baseURL: "https://p2.local/v1", models: ["m2", "only-in-p2"] } },
      { kind: "core:extensions-loaded" },
      { kind: "activate-backend", name: "ash" },
    ],
  });
  const info = pickEvents(result.events, "agent:info")[0];
  assert.equal(info.provider, "p2");
  assert.equal(info.model, "only-in-p2");
  assert.deepEqual(pickEvents(result.events, "ui:error"), []);
});

test("a default provider with a key but no model falls back to one that has a model", async () => {
  const result = await runDriver({ defaultProvider: "empty" }, {
    capture: ["agent:info", "ui:error"],
    steps: [
      { kind: "providers.register", payload: { id: "empty", apiKey: "k1", baseURL: "https://empty.local/v1", models: [] } },
      { kind: "providers.register", payload: { id: "p2", apiKey: "k2", baseURL: "https://p2.local/v1", models: ["m2"] } },
      { kind: "core:extensions-loaded" },
      { kind: "activate-backend", name: "ash" },
    ],
  });
  const errors = pickEvents(result.events, "ui:error").map((e) => e.message);
  assert.ok(errors.some((m) => m.includes('"empty" has no model configured; falling back to "p2"')), JSON.stringify(errors));
  const info = pickEvents(result.events, "agent:info")[0];
  assert.equal(info.provider, "p2");
  assert.equal(info.model, "m2");
});

test("keys.json edits reach a built-in provider and the active client without restart", async () => {
  const base = [
    { kind: "save-keys", keys: { deepseek: "sk-1" } },
    { kind: "activate-provider", name: "deepseek" },
    { kind: "core:extensions-loaded" },
    { kind: "activate-backend", name: "ash" },
  ];
  const rotated = await runDriver({}, {
    dumpModels: true, probeLlmClient: true, capture: [],
    steps: [...base, { kind: "save-keys", keys: { deepseek: "sk-2" } }, { kind: "providers-changed" }, { kind: "wait" }],
  });
  assert.equal(rotated.models!.find((m) => m.provider === "deepseek")?.endpoint.apiKey, "sk-2");
  assert.deepEqual(rotated.llmClient, { enabled: true, apiKey: "sk-2" }, "active client picks up the new key");

  const removed = await runDriver({}, {
    dumpModels: true, probeLlmClient: true, capture: [],
    steps: [...base, { kind: "save-keys", keys: {} }, { kind: "providers-changed" }, { kind: "wait" }],
  });
  assert.equal(removed.models!.some((m) => m.provider === "deepseek"), false);
  assert.deepEqual(removed.llmClient, { enabled: false, apiKey: "" }, "removed key disables the active client");
});

const levelsProvider = {
  id: "lv", apiKey: "k", baseURL: "https://lv.local/v1", defaultModel: "plain",
  models: ["plain", { id: "deep", reasoningLevels: ["off", "high", "max"] }],
};

test("undeclared models keep the default ladder and the xhigh→high clamp", async () => {
  const r = await runDriver({ thinkingLevel: "xhigh" }, {
    probeThinking: true, capture: [],
    steps: [{ kind: "providers.register", payload: levelsProvider }, { kind: "core:extensions-loaded" }, { kind: "activate-backend", name: "ash" }],
  });
  assert.equal(r.thinking!.model, "plain");
  assert.deepEqual(r.thinking!.levels, ["off", "low", "medium", "high", "xhigh"]);
  assert.equal(r.thinking!.level, "xhigh");
  assert.deepEqual(r.thinking!.params, { reasoning_effort: "high" });
});

test("a model's declared levels drive the menu, and the preference maps to the nearest", async () => {
  const r = await runDriver({ thinkingLevel: "xhigh" }, {
    probeThinking: true, capture: [],
    steps: [
      { kind: "providers.register", payload: levelsProvider }, { kind: "core:extensions-loaded" }, { kind: "activate-backend", name: "ash" },
      { kind: "switch-model", id: "deep", provider: "lv" },
    ],
  });
  assert.deepEqual(r.thinking!.levels, ["off", "high", "max"]);
  assert.equal(r.thinking!.level, "max", "xhigh maps to max, sent as is");
  assert.deepEqual(r.thinking!.params, { reasoning_effort: "max" });
});

test("/thinking accepts max, keeps it as the preference, and reports the level a model uses", async () => {
  const r = await runDriver({}, {
    probeThinking: true, capture: ["ui:info", "ui:error"],
    steps: [
      { kind: "providers.register", payload: { ...levelsProvider, defaultModel: "o", models: [{ id: "o", reasoningLevels: ["low", "medium", "high"] }] } },
      { kind: "core:extensions-loaded" }, { kind: "activate-backend", name: "ash" },
      { kind: "set-thinking", level: "max" },
    ],
  });
  assert.deepEqual(pickEvents(r.events, "ui:error"), []);
  const infos = pickEvents(r.events, "ui:info").map((e) => e.message);
  assert.ok(infos.includes("Thinking: o supports low, medium, high; using high."), JSON.stringify(infos));
  assert.equal(r.thinking!.level, "high");
  assert.deepEqual(r.thinking!.params, { reasoning_effort: "high" });
});

test("settings.json can declare levels per provider and per model", async () => {
  const r = await runDriver({
    defaultProvider: "flat", thinkingLevel: "xhigh",
    providers: { flat: { apiKey: "k", baseURL: "https://flat.local/v1", reasoningLevels: ["off", "low", "medium", "high", "xhigh"], models: ["gpt-x"] } },
  }, {
    probeThinking: true, capture: [],
    steps: [{ kind: "core:extensions-loaded" }, { kind: "activate-backend", name: "ash" }],
  });
  assert.deepEqual(r.thinking!.levels, ["off", "low", "medium", "high", "xhigh"]);
  assert.deepEqual(r.thinking!.params, { reasoning_effort: "xhigh" }, "declared xhigh is sent, not clamped");
});

test("native DeepSeek offers off/high/max and sends max", async () => {
  const r = await runDriver({ defaultProvider: "deepseek", thinkingLevel: "xhigh" }, {
    probeThinking: true, capture: [],
    steps: [{ kind: "activate-provider", name: "deepseek" }, { kind: "core:extensions-loaded" }, { kind: "activate-backend", name: "ash" }],
  }, { DEEPSEEK_API_KEY: "sk-test" });
  assert.deepEqual(r.thinking!.levels, ["off", "high", "max"]);
  assert.deepEqual(r.thinking!.params, { thinking: { type: "enabled" }, reasoning_effort: "max" });
});
