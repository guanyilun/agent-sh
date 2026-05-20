import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../../dist/cli/index.js", import.meta.url));

interface RunResult {
  code: number | null;
  stderr: string;
  stdout: string;
}

function runCli(args: string[], home: string, extraEnv: Record<string, string> = {}): Promise<RunResult> {
  return new Promise<RunResult>((resolve) => {
    const child = spawn("node", [CLI, ...args], {
      env: {
        PATH: process.env.PATH,
        HOME: home,
        AGENT_SH_HOME: home,
        AGENT_SH_SKIP_SHELL_ENV: "1",
        ...extraEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    let stdout = "";
    child.stderr!.on("data", (c) => { stderr += c.toString(); });
    child.stdout!.on("data", (c) => { stdout += c.toString(); });
    child.on("close", (code) => resolve({ code, stderr, stdout }));
  });
}

function freshHome(): string {
  return mkdtempSync(join(tmpdir(), "agent-sh-subcmd-"));
}

test("`agent-sh init --force` scaffolds settings.json under AGENT_SH_HOME", async () => {
  const home = freshHome();
  try {
    const { code, stdout } = await runCli(["init", "--force"], home);
    assert.equal(code, 0, stdout);
    assert.ok(existsSync(join(home, "settings.json")), "settings.json should exist");
    assert.ok(existsSync(join(home, "settings.example.json")), "settings.example.json should exist");
    assert.match(stdout, /agent-sh initialized at /);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("`agent-sh list` exits cleanly with no extensions installed", async () => {
  const home = freshHome();
  try {
    const { code, stdout } = await runCli(["list"], home);
    assert.equal(code, 0, stdout);
    assert.match(stdout, /No extensions installed\./);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("`agent-sh auth list` exits cleanly with no providers configured", async () => {
  const home = freshHome();
  try {
    const { code } = await runCli(["auth", "list"], home);
    assert.equal(code, 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("`agent-sh auth <bogus>` errors out with non-zero exit", async () => {
  const home = freshHome();
  try {
    const { code, stderr } = await runCli(["auth", "definitely-not-a-subcommand"], home);
    assert.equal(code, 1);
    assert.match(stderr, /unknown subcommand/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("`agent-sh --version` exits 0 and prints a version-like string", async () => {
  const home = freshHome();
  try {
    const { code, stdout } = await runCli(["--version"], home);
    assert.equal(code, 0);
    assert.match(stdout.trim(), /^\d+\.\d+\.\d+/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("`agent-sh --help` exits 0 and prints usage", async () => {
  const home = freshHome();
  try {
    const { code, stdout } = await runCli(["--help"], home);
    assert.equal(code, 0);
    assert.match(stdout, /Usage: agent-sh/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

const BUNDLED_FIXTURE = "secret-guard";
const BUNDLED_TARGET_FILE = `${BUNDLED_FIXTURE}.ts`;

test("`agent-sh install <bundled-single-file>` copies the file into <HOME>/extensions/", async () => {
  const home = freshHome();
  try {
    const { code, stdout } = await runCli(["install", BUNDLED_FIXTURE], home);
    assert.equal(code, 0, stdout);
    assert.ok(
      existsSync(join(home, "extensions", BUNDLED_TARGET_FILE)),
      `expected ${BUNDLED_TARGET_FILE} under <home>/extensions/`,
    );
    assert.match(stdout, /Installed:/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("`agent-sh install <unknown>` exits 1 and lists available bundled extensions", async () => {
  const home = freshHome();
  try {
    const { code, stderr } = await runCli(["install", "definitely-not-bundled"], home);
    assert.equal(code, 1);
    assert.match(stderr, /No bundled extension named/);
    assert.match(stderr, new RegExp(BUNDLED_FIXTURE));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("`agent-sh install` of an already-installed extension refuses without --force, then succeeds with --force", async () => {
  const home = freshHome();
  try {
    const first = await runCli(["install", BUNDLED_FIXTURE], home);
    assert.equal(first.code, 0, first.stdout);

    const second = await runCli(["install", BUNDLED_FIXTURE], home);
    assert.equal(second.code, 1);
    assert.match(second.stderr, /already exists/);

    const third = await runCli(["install", BUNDLED_FIXTURE, "--force"], home);
    assert.equal(third.code, 0, third.stdout);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("install then uninstall removes the extension from disk", async () => {
  const home = freshHome();
  try {
    const installed = await runCli(["install", BUNDLED_FIXTURE], home);
    assert.equal(installed.code, 0, installed.stdout);
    assert.ok(existsSync(join(home, "extensions", BUNDLED_TARGET_FILE)));

    const removed = await runCli(["uninstall", BUNDLED_TARGET_FILE], home);
    assert.equal(removed.code, 0, removed.stdout);
    assert.ok(
      !existsSync(join(home, "extensions", BUNDLED_TARGET_FILE)),
      "extension file should be gone after uninstall",
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
