import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_HOME = mkdtempSync(join(tmpdir(), "agent-sh-loader-test-"));
process.env.AGENT_SH_HOME = TEST_HOME;

const { loadExtensions, reloadExtensions } = await import("../../src/core/extension-loader.js");
const { reloadSettings } = await import("../../src/core/settings.js");

const EXT_DIR = join(TEST_HOME, "extensions");
const SETTINGS_PATH = join(TEST_HOME, "settings.json");

function resetExtDir(): void {
  try { rmSync(EXT_DIR, { recursive: true, force: true }); } catch {}
  mkdirSync(EXT_DIR, { recursive: true });
}

function removeExtDir(): void {
  try { rmSync(EXT_DIR, { recursive: true, force: true }); } catch {}
}

function writeSettings(obj: Record<string, unknown>): void {
  writeFileSync(SETTINGS_PATH, JSON.stringify(obj));
  reloadSettings();
}

function clearSettings(): void {
  try { rmSync(SETTINGS_PATH, { force: true }); } catch {}
  reloadSettings();
}

// Each test uses unique extension names to dodge ESM module cache between tests.
let counter = 0;
function uniq(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}-${Date.now().toString(36)}`;
}

function writeStubExtension(name: string): string {
  const file = join(EXT_DIR, `${name}.ts`);
  writeFileSync(file, "export default function activate() {}\n");
  return file;
}

function makeStubCtx(): { ctx: any; uiErrors: string[] } {
  const uiErrors: string[] = [];
  const noop = () => {};
  const bus = {
    emit: (event: string, payload: any) => {
      if (event === "ui:error") uiErrors.push(payload?.message ?? String(payload));
    },
    on: noop, onPipe: noop, off: noop, offPipe: noop,
    emitPipe: (_: any, e: any) => e,
  };
  function deep(): any {
    return new Proxy(function () {}, {
      get(_, p) {
        if (p === "then" || p === Symbol.toPrimitive) return undefined;
        return deep();
      },
      apply: () => deep(),
    });
  }
  const ctx = new Proxy({}, { get(_, p) { return p === "bus" ? bus : deep(); } });
  return { ctx, uiErrors };
}

test("loadExtensions returns [] silently when EXT_DIR is missing", async () => {
  removeExtDir();
  clearSettings();
  const { ctx, uiErrors } = makeStubCtx();
  const loaded = await loadExtensions(ctx);
  assert.deepEqual(loaded, []);
  assert.deepEqual(uiErrors, []);
});

test("dangling symlink emits ui:error and discovery continues past it (regression)", async () => {
  resetExtDir();
  clearSettings();
  const first = uniq("a-first");
  const last = uniq("c-last");
  writeStubExtension(first);
  symlinkSync("/nonexistent/agent-sh-loader-test/target.ts", join(EXT_DIR, `${uniq("b-broken")}.ts`));
  writeStubExtension(last);

  const { ctx, uiErrors } = makeStubCtx();
  const loaded = await loadExtensions(ctx);

  // Pre-fix: only `first` would load — the broken symlink threw and the outer
  // catch swallowed both the error and every later entry.
  assert.ok(loaded.includes(first), `expected ${first} in ${JSON.stringify(loaded)}`);
  assert.ok(loaded.includes(last), `expected ${last} in ${JSON.stringify(loaded)}`);

  const symlinkErr = uiErrors.find((m) => /b-broken/.test(m));
  assert.ok(symlinkErr, `expected a ui:error mentioning the broken symlink, got ${JSON.stringify(uiErrors)}`);
  assert.match(symlinkErr!, /ENOENT/i);
});

function makeAgentCtx(): { ctx: any; registry: Map<string, any> } {
  const registry = new Map<string, any>();
  const noop = () => {};
  const unsub = () => () => {};
  const bus = { emit: noop, on: noop, onPipe: noop, off: noop, offPipe: noop, emitPipe: (_: any, e: any) => e };
  const agent = {
    getTools: () => [...registry.values()],
    registerTool: (t: any) => registry.set(t.name, t),
    unregisterTool: (n: string) => registry.delete(n),
    adviseTool: unsub, adviseToolSchema: unsub, adviseInstruction: unsub, adviseSkill: unsub,
    registerInstruction: noop, removeInstruction: noop,
    registerSkill: noop, removeSkill: noop,
    registerContextProducer: unsub,
  };
  const ctx = { bus, agent, advise: unsub, registerCommand: noop, adviseCommand: unsub, shell: undefined };
  return { ctx, registry };
}

test("dispose snapshots cleanups so a teardown re-register survives (footgun B regression)", async () => {
  resetExtDir();
  clearSettings();
  const name = uniq("restorer");
  // Extension re-registers a tool on teardown; the dispose snapshot must keep
  // that from being undone within the same loop.
  writeFileSync(
    join(EXT_DIR, `${name}.ts`),
    `export default function activate(ctx){ ctx.onDispose(()=>{ ctx.agent.registerTool({ name: "restored-marker", execute: async () => ({ content: "", exitCode: 0, isError: false }) }); }); }\n`,
  );
  const { ctx, registry } = makeAgentCtx();
  await loadExtensions(ctx);
  assert.ok(!registry.has("restored-marker"), "marker should only appear on dispose");
  await reloadExtensions(ctx);
  assert.ok(registry.has("restored-marker"), "teardown re-register must survive the dispose loop");
});

test("disabled extensions are skipped without emitting ui:error", async () => {
  resetExtDir();
  const kept = uniq("kept");
  const skipped = uniq("skipped");
  writeStubExtension(kept);
  writeStubExtension(skipped);
  writeSettings({ disabledExtensions: [skipped] });

  const { ctx, uiErrors } = makeStubCtx();
  const loaded = await loadExtensions(ctx);

  assert.ok(loaded.includes(kept));
  assert.ok(!loaded.includes(skipped));
  assert.deepEqual(uiErrors, []);
});
