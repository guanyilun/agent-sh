import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { createCore } from "../../../../src/core/index.js";
import { activateAgent } from "../../../../src/agent/index.js";
import { loadBuiltinExtensions } from "../../../../src/extensions/index.js";
import activateRollingHistory from "../../../../src/agent/extensions/rolling-history/index.js";
import type { AppConfig } from "../../../../src/shell/host-types.js";
import type { ToolDefinition } from "../../../../src/agent/types.js";

interface CommandReg { name: string; handler: (args: string) => Promise<void> | void; }

async function flush(n = 12): Promise<void> {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
}

async function bootWithRollingHistory(storeDir: string): Promise<{
  core: ReturnType<typeof createCore>;
  commands: Map<string, CommandReg["handler"]>;
}> {
  const core = createCore({ defaultBackend: "ash", historyDir: storeDir } as AppConfig & { historyDir?: string });
  const ctx = core.extensionContext({ quit: () => {} });
  // Pin getStoragePath("rolling-history") to a tmpdir.
  (ctx as { getStoragePath: (ns: string) => string }).getStoragePath = () => storeDir;

  // Capture slash-command registrations so the test can fire /history.
  const commands = new Map<string, CommandReg["handler"]>();
  core.bus.on("command:register", ({ name, handler }) => { commands.set(name, handler); });

  // Minimal conversation-state handlers the captureHandler relies on.
  const messages: Array<{ role: string; content: string; meta?: Record<string, unknown> }> = [];
  ctx.define("conversation:get-messages", () => messages);
  ctx.define("conversation:replace-messages", (msgs: typeof messages) => { messages.length = 0; messages.push(...msgs); });
  ctx.define("conversation:link", (_idx: number, _id: string) => undefined);
  ctx.define("conversation:estimate-tokens", () => 0);
  ctx.define("conversation:estimate-prompt-tokens", () => 0);

  activateAgent(ctx);
  await loadBuiltinExtensions(ctx, ["file-autocomplete"]);
  activateRollingHistory(ctx);
  return { core, commands };
}

test("bridge boot (no activateRollingHistory) → conversation_recall absent from tools", async () => {
  const core = createCore({ defaultBackend: "ash" } as AppConfig);
  const ctx = core.extensionContext({ quit: () => {} });
  activateAgent(ctx);
  await loadBuiltinExtensions(ctx, ["file-autocomplete"]);
  // Deliberately do NOT activateRollingHistory — mirrors what bridges do.

  const { tools } = core.bus.emitPipe("agent:tools", { tools: [] as ToolDefinition[] });
  const names = tools.map((t) => t.name);
  assert.ok(!names.includes("conversation_recall"),
    `bridge boot should not register conversation_recall; got: ${names.join(", ")}`);
});

test("shell boot (with activateRollingHistory) → conversation_recall registered", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "rh-act-"));
  try {
    const { core } = await bootWithRollingHistory(tmpDir);
    const { tools } = core.bus.emitPipe("agent:tools", { tools: [] as ToolDefinition[] });
    const names = tools.map((t) => t.name);
    assert.ok(names.includes("conversation_recall"),
      `shell boot should register conversation_recall; got: ${names.join(", ")}`);
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }
});

test("/history off gates writes; /history on resumes", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "rh-toggle-"));
  const historyFile = path.join(tmpDir, "history.jsonl");
  try {
    const { core, commands } = await bootWithRollingHistory(tmpDir);
    const messages = (core.handlers.call("conversation:get-messages") as Array<{ role: string; content: string }>);

    // Turn 1 — writes on (default).
    messages.push({ role: "user", content: "first turn while on" });
    core.bus.emit("conversation:message-appended", { role: "user", content: "first turn while on" });
    await flush();
    const sizeAfterFirst = fs.existsSync(historyFile) ? fs.statSync(historyFile).size : 0;
    assert.ok(sizeAfterFirst > 0, "first turn should have produced disk writes");

    // /history off.
    const toggle = commands.get("history")!;
    assert.ok(toggle, "/history command should be registered");
    await toggle("off");

    // Turn 2 — writes off.
    messages.push({ role: "user", content: "second turn while off" });
    core.bus.emit("conversation:message-appended", { role: "user", content: "second turn while off" });
    await flush();
    const sizeAfterOff = fs.statSync(historyFile).size;
    assert.equal(sizeAfterOff, sizeAfterFirst,
      "file should not grow while /history off");
    assert.ok(!fs.readFileSync(historyFile, "utf-8").includes("second turn while off"),
      "off-turn content must not appear on disk");

    // /history on resumes.
    await toggle("on");
    messages.push({ role: "user", content: "third turn after re-enable" });
    core.bus.emit("conversation:message-appended", { role: "user", content: "third turn after re-enable" });
    await flush();
    assert.ok(fs.statSync(historyFile).size > sizeAfterOff,
      "file should grow once writes resume");
    assert.ok(fs.readFileSync(historyFile, "utf-8").includes("third turn after re-enable"));
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }
});

test("/history off also gates linkMessage (no stale entryId stamping)", async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "rh-link-"));
  try {
    const { core, commands } = await bootWithRollingHistory(tmpDir);
    const messages = (core.handlers.call("conversation:get-messages") as Array<{ role: string; content: string; meta?: Record<string, unknown> }>);
    const linkCalls: Array<{ idx: number; id: string }> = [];
    // Replace the no-op link handler with one that records calls.
    core.handlers.define("conversation:link", (idx: number, id: string) => { linkCalls.push({ idx, id }); });

    await commands.get("history")!("off");
    messages.push({ role: "user", content: "off-turn" });
    core.bus.emit("conversation:message-appended", { role: "user", content: "off-turn" });
    await flush();

    assert.equal(linkCalls.length, 0, "linkMessage should not fire while /history off");
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }
});
