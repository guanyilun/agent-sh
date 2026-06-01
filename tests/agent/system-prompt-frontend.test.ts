import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCore } from "../../src/core/index.js";
import agentBackend from "../../src/agent/index.js";
import activateShellContext from "../../src/shell/shell-context.js";
import type { AppConfig, ExtensionContext } from "../../src/shell/host-types.js";
import type { AgentSurface } from "../../src/agent/host-types.js";

process.env.AGENT_SH_HOME = mkdtempSync(join(tmpdir(), "agent-sh-sp-"));
process.env.AGENT_SH_SKIP_SHELL_ENV = "1";

/** Boot a core with the ash backend active, the way a frontend launcher does. */
async function activeAgentCtx(): Promise<ExtensionContext> {
  const core = createCore({} as AppConfig);
  const ctx = core.extensionContext({ quit: () => {} });
  agentBackend(ctx);
  const agent = (ctx as ExtensionContext & { agent: AgentSurface }).agent;
  agent.providers.register({ id: "test", apiKey: "k", baseURL: "http://localhost", defaultModel: "m", models: [{ id: "m" }] });
  core.bus.emit("core:extensions-loaded", { names: [] });
  await core.activateBackend("ash");
  await new Promise((r) => setImmediate(r));
  return ctx;
}

test("with no frontend advised, the prompt is identity + guide and carries no surface section", async () => {
  const ctx = await activeAgentCtx();
  const p = ctx.call("system-prompt:build") as string;
  assert.ok(p.startsWith("You are ash"), "identity is paragraph one");
  assert.ok(p.includes("agent-sh source and documentation"), "code/tools guide present");
  assert.ok(!p.includes("terminal shell") && !p.includes("ashi, an interactive"), "no surface section is invented");
});

test("an advised frontend surface sits between the identity and the guide", async () => {
  const ctx = await activeAgentCtx();
  ctx.advise("system-prompt:frontend", () => "MARKER_SURFACE");
  const p = ctx.call("system-prompt:build") as string;
  const identity = p.indexOf("You are ash");
  const surface = p.indexOf("MARKER_SURFACE");
  const guide = p.indexOf("agent-sh source and documentation");
  assert.ok(identity < surface && surface < guide, `expected identity < surface < guide, got ${identity}, ${surface}, ${guide}`);
});

test("companion frontend (no ctx.shell): shell_events explained, but no cwd-drift note", async () => {
  const ctx = await activeAgentCtx();
  activateShellContext(ctx);
  const p = ctx.call("system-prompt:build") as string;
  assert.ok(p.includes("<shell_events>"), "shell_events is explained when shell-context is active");
  assert.ok(p.includes("standing preferences"), "preference-learning guidance travels with the emitter");
  assert.ok(!p.includes("tool calls run in"), "no cwd-drift guidance when the agent owns its own fixed cwd");
});

test("shell frontend (ctx.shell present): <cwd> is explained as following the user's cd", async () => {
  const ctx = await activeAgentCtx();
  (ctx as { shell?: unknown }).shell = {};
  activateShellContext(ctx);
  const p = ctx.call("system-prompt:build") as string;
  assert.ok(p.includes("tool calls run in"), "cwd-drift guidance present under the shell frontend");
});
