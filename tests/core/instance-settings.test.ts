import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "agent-sh-instance-settings-"));
process.env.AGENT_SH_HOME = home;

const {
  createSettingsService, globalSettingsService, getSettings, reloadSettings,
  setSessionOverlay, clearSessionOverlay,
} = await import("../../src/core/settings.js");
const { createCore } = await import("../../src/core/index.js");
const { default: agentBackend } = await import("../../src/agent/index.js");

const settingsPath = join(home, "settings.json");
writeFileSync(settingsPath, JSON.stringify({ defaultBackend: "global-backend", autoCompactThreshold: 0.7 }));
reloadSettings();

test("instance overlays are independent of each other and the global service", () => {
  const a = createSettingsService({ autoCompactThreshold: 0.2 });
  const b = createSettingsService({ autoCompactThreshold: 0.3 });
  setSessionOverlay({ autoCompactThreshold: 0.9 });
  try {
    a.setSessionOverlay({ autoCompact: false, autoCompactThreshold: 0.1 });
    b.setSessionOverlay({ autoCompactThreshold: 0.4 });
    assert.equal(a.get().autoCompactThreshold, 0.1);
    assert.equal(b.get().autoCompactThreshold, 0.4);
    assert.equal(getSettings().autoCompactThreshold, 0.9);
    assert.equal(a.getSettingSource("autoCompactThreshold"), "session");
    a.clearSessionOverlay("autoCompactThreshold");
    assert.equal(a.get().autoCompactThreshold, 0.2);
    assert.equal(a.getSettingSource("autoCompactThreshold"), "file");
    assert.equal(a.get().autoCompact, false);
    a.clearSessionOverlay();
    assert.equal(a.get().autoCompact, true);
    assert.equal(a.getSettingSource("autoCompact"), "default");
    assert.equal(b.get().autoCompactThreshold, 0.4);
  } finally {
    clearSessionOverlay();
  }
});

test("factory uses cloned defaults, not global file, env, or overlay values", () => {
  const oldEnv = process.env.AGENT_SH_AUTO_COMPACT;
  process.env.AGENT_SH_AUTO_COMPACT = "off";
  setSessionOverlay({ defaultBackend: "session-backend" });
  try {
    const a = createSettingsService();
    const b = createSettingsService();
    assert.equal(a.get().autoCompact, true);
    assert.equal(a.get().autoCompactThreshold, 0.5);
    assert.equal(a.get().defaultBackend, "ash");
    assert.equal(a.get().diffMaxLines, Infinity);
    a.get().extensions.push("leak");
    a.get().coreTools.push("leak");
    assert.deepEqual(a.get().extensions, []);
    assert.deepEqual(b.get().coreTools, []);
    // The legacy API exposes default arrays; later mutations must not change
    // defaults already captured by an instance service.
    const globalExtensions = getSettings().extensions;
    const length = globalExtensions.length;
    try {
      globalExtensions.push("global-mutation");
      assert.deepEqual(a.get().extensions, []);
    } finally {
      globalExtensions.length = length;
    }
  } finally {
    if (oldEnv === undefined) delete process.env.AGENT_SH_AUTO_COMPACT;
    else process.env.AGENT_SH_AUTO_COMPACT = oldEnv;
    clearSessionOverlay();
  }
});

test("snapshots, overlays, updates, and extension results do not share nested data", () => {
  const snapshot = {
    providers: { local: { apiKey: "key", models: [{ id: "first", modalities: ["text" as const] }] } },
    widget: { nested: { enabled: true } },
  };
  const a = createSettingsService(snapshot);
  const b = createSettingsService(snapshot);
  snapshot.providers.local.models[0]!.id = "changed-input";
  snapshot.widget.nested.enabled = false;
  a.get().providers.local!.models!.push("changed-result");
  const ext = a.getExtensionSettings("widget", { nested: { enabled: false }, size: 3 });
  assert.equal(ext.nested.enabled, true);
  ext.nested.enabled = false;
  assert.equal(a.getExtensionSettings("widget", { nested: { enabled: false } }).nested.enabled, true);

  const patch = { providers: { local: { defaultModel: "second", models: ["second"] } } };
  a.update(patch);
  patch.providers.local.models.push("changed-patch");
  assert.deepEqual(a.get().providers.local!.models, ["second"]);
  assert.equal(a.get().providers.local!.apiKey, "key");
  assert.deepEqual(b.get().providers.local!.models, [{ id: "first", modalities: ["text"] }]);

  const overlay = { providers: { local: { models: ["overlay"] } } };
  a.setSessionOverlay(overlay);
  overlay.providers.local.models.push("changed-overlay");
  assert.deepEqual(a.get().providers.local!.models, ["overlay"]);
  a.clearSessionOverlay();
  assert.equal(a.get().providers.local!.defaultModel, "second");
  assert.equal(a.getSettingSource("providers"), "file");
});

test("provider resolution reads the instance snapshot and clones model capabilities", () => {
  const service = createSettingsService({
    providers: {
      local: { apiKey: "key", baseURL: "https://instance.example", models: [{ id: "local-model", reasoning: true, modalities: ["text"] }] },
    },
  });
  assert.deepEqual(service.getProviderNames(), ["local"]);
  assert.equal(service.resolveProvider("missing"), null);
  const provider = service.resolveProvider("local")!;
  assert.equal(provider.apiKey, "key");
  assert.equal(provider.baseURL, "https://instance.example");
  assert.equal(provider.defaultModel, "local-model");
  assert.equal(provider.modelsExplicit, true);
  provider.modelCapabilities!.get("local-model")!.modalities!.push("image");
  assert.deepEqual(service.resolveProvider("local")!.modelCapabilities!.get("local-model")!.modalities, ["text"]);
});

test("core selects instance defaults, exposes its service, and scopes backend persistence", async () => {
  const before = readFileSync(settingsPath, "utf8");
  const a = createCore({ settingsService: createSettingsService({ defaultBackend: "second", widget: { size: 9 } }) });
  const b = createCore({ settings: createSettingsService({ defaultBackend: "first" }) });
  const starts: string[] = [];
  for (const [label, core] of [["a", a], ["b", b]] as const) {
    for (const name of ["first", "second"]) {
      core.bus.emit("agent:register-backend", { name, start: () => { starts.push(`${label}:${name}`); }, kill: () => {} });
    }
  }
  try {
    assert.equal(a.handlers.call("config:settings"), a.settings);
    const ctx = a.extensionContext({ quit: () => {} });
    assert.equal(ctx.call("config:settings"), a.settings);
    assert.deepEqual(ctx.getExtensionSettings("widget", { size: 1 }), { size: 9 });
    await a.activateBackend();
    await b.activateBackend();
    assert.deepEqual(starts, ["a:second", "b:first"]);
    b.settings.update({ defaultBackend: "second" });
    const saved = new Promise<void>((resolve) => a.bus.on("config:changed", () => resolve()));
    a.bus.emit("config:switch-backend", { name: "first" });
    await saved;
    assert.equal(a.settings.get().defaultBackend, "first");
    assert.equal(b.settings.get().defaultBackend, "second");
    assert.equal(readFileSync(settingsPath, "utf8"), before);
    assert.equal(getSettings().defaultBackend, "global-backend");
  } finally {
    a.kill();
    b.kill();
  }
});

test("CLI cores retain the legacy global settings service", () => {
  const core = createCore({});
  assert.equal(core.settings, globalSettingsService);
  assert.equal(core.handlers.call("config:settings"), globalSettingsService);
  setSessionOverlay({ defaultBackend: "legacy-session" });
  try {
    assert.equal(core.settings.get().defaultBackend, "legacy-session");
  } finally {
    clearSessionOverlay();
    core.kill();
  }
});

test("agent bootstrap resolves providers and compact controls through the context service", async () => {
  const before = getSettings();
  const makeCore = (model: string) => createCore({ settingsService: createSettingsService({
    defaultProvider: "local",
    historyFilePath: join(home, `${model}.history`),
    providers: { local: { apiKey: "key", baseURL: "https://instance.example", defaultModel: model } },
  }) });
  const a = makeCore("model-a");
  const b = makeCore("model-b");
  const commands = new Map<string, (args: string) => void | Promise<void>>();
  a.bus.on("command:register", ({ name, handler }) => { commands.set(name, handler); });
  try {
    agentBackend(a.extensionContext({ quit: () => {} }));
    agentBackend(b.extensionContext({ quit: () => {} }));
    a.bus.emit("core:extensions-loaded", { names: [] });
    b.bus.emit("core:extensions-loaded", { names: [] });
    assert.equal(a.handlers.call("llm:get-client").model, "model-a");
    assert.equal(b.handlers.call("llm:get-client").model, "model-b");
    assert.deepEqual(a.handlers.call("agent:get-models").map((m: { id: string }) => m.id), ["model-a"]);
    assert.equal(a.handlers.call("agent:resolve-endpoint", { provider: "local", id: "model-a" }).baseURL, "https://instance.example");
    await a.activateBackend();
    const compact = commands.get("/compact")!;
    assert.equal(typeof compact, "function");
    await compact("off");
    await compact("threshold 0.25");
    assert.equal(a.settings.get().autoCompact, false);
    assert.equal(a.settings.get().autoCompactThreshold, 0.25);
    assert.equal(b.settings.get().autoCompact, true);
    assert.equal(b.settings.get().autoCompactThreshold, 0.5);
    const messages: string[] = [];
    a.bus.on("ui:info", ({ message }) => { messages.push(message); });
    await compact("status");
    assert.ok(messages.some((message) => message.includes("off (session), threshold: 0.25 (session)")));
    await compact("reset");
    assert.equal(a.settings.get().autoCompact, true);
    assert.equal(a.settings.get().autoCompactThreshold, 0.5);
    assert.deepEqual(getSettings(), before);
  } finally {
    a.kill();
    b.kill();
  }
});

test.after(() => {
  clearSessionOverlay();
  rmSync(home, { recursive: true, force: true });
});
