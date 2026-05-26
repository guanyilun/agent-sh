import test from "node:test";
import assert from "node:assert/strict";
import { createCore } from "../../src/core/index.js";
import activateShellContext from "../../src/shell/shell-context.js";

function setup(): { core: ReturnType<typeof createCore> } {
  const core = createCore({});
  const ctx = core.extensionContext({ quit: () => {} });
  activateShellContext(ctx);
  return { core };
}

function captureQueryContext(core: ReturnType<typeof createCore>): string {
  return String(core.handlers.call("query-context:build") ?? "");
}

test("user shell command lands in <shell_events> on next query-context", () => {
  const { core } = setup();
  core.bus.emit("shell:command-done", {
    command: "ls",
    output: "file1\nfile2",
    cwd: "/work",
    exitCode: 0,
  });
  const ctxText = captureQueryContext(core);
  assert.match(ctxText, /<shell_events>/);
  assert.match(ctxText, /\$ ls/);
  assert.match(ctxText, /file1/);
});

test("agent-invoked shell command is NOT injected", () => {
  const { core } = setup();
  core.bus.emit("shell:agent-exec-start", {});
  core.bus.emit("shell:command-done", {
    command: "ls",
    output: "agent_run",
    cwd: "/work",
    exitCode: 0,
  });
  core.bus.emit("shell:agent-exec-done", {});
  const ctxText = captureQueryContext(core);
  assert.doesNotMatch(ctxText, /<shell_events>/);
  assert.doesNotMatch(ctxText, /agent_run/);
});

test("shell:user-exec-exclude-next omits the next command from <shell_events>", () => {
  const { core } = setup();
  core.bus.emit("shell:user-exec-exclude-next", {});
  core.bus.emit("shell:command-done", {
    command: "cat ~/.secret",
    output: "topsecret",
    cwd: "/work",
    exitCode: 0,
  });
  const ctxText = captureQueryContext(core);
  assert.doesNotMatch(ctxText, /topsecret/);
  assert.doesNotMatch(ctxText, /cat ~\/.secret/);
});

test("exclude-next flag is one-shot — the command after it IS injected", () => {
  const { core } = setup();
  core.bus.emit("shell:user-exec-exclude-next", {});
  core.bus.emit("shell:command-done", {
    command: "cat ~/.secret",
    output: "topsecret",
    cwd: "/work",
    exitCode: 0,
  });
  core.bus.emit("shell:command-done", {
    command: "ls",
    output: "public",
    cwd: "/work",
    exitCode: 0,
  });
  const ctxText = captureQueryContext(core);
  assert.doesNotMatch(ctxText, /topsecret/);
  assert.match(ctxText, /public/);
});
