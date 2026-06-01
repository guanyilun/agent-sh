import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../../dist/cli/index.js", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

function runOnce(args: string[], home: string, timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("node", [CLI, ...args], {
      env: { PATH: process.env.PATH, HOME: home, AGENT_SH_HOME: home, AGENT_SH_SKIP_SHELL_ENV: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (c) => { stdout += c.toString(); });
    child.stderr!.on("data", (c) => { stderr += c.toString(); });
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

/** A minimal extension whose only dependency is agent-sh, so that under --dev
 *  npm install is offline via the file: link and there is no build step. */
function makeExtension(): { ext: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), "agent-sh-devext-"));
  const ext = join(root, "dev-test-ext");
  mkdirSync(ext);
  writeFileSync(join(ext, "package.json"), JSON.stringify({
    name: "dev-test-ext",
    version: "0.0.0",
    type: "module",
    dependencies: { "agent-sh": "^0.14.11" },
  }, null, 2));
  writeFileSync(join(ext, "index.js"), "export default function activate() {}\n");
  return { ext, root };
}

test("install --dev repoints the extension's agent-sh dep at the host core", { timeout: 120000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), "agent-sh-devhome-"));
  const { ext, root } = makeExtension();
  try {
    const res = await runOnce(["install", `file:${ext}`, "--dev"], home, 90000);
    assert.equal(res.code, 0, `install failed:\nstdout: ${res.stdout}\nstderr: ${res.stderr}`);

    // AGENT_SH_HOME is the config dir directly, so extensions land in <home>/extensions.
    const installed = join(home, "extensions", "dev-test-ext");
    const pkg = JSON.parse(readFileSync(join(installed, "package.json"), "utf-8"));
    assert.ok(
      typeof pkg.dependencies["agent-sh"] === "string" && pkg.dependencies["agent-sh"].startsWith("file:"),
      `agent-sh dep should be a file: link, got ${pkg.dependencies["agent-sh"]}`,
    );

    // npm links the file: dep — the installed copy resolves to the host repo.
    const linked = realpathSync(join(installed, "node_modules", "agent-sh"));
    assert.equal(linked, realpathSync(REPO_ROOT), "node_modules/agent-sh resolves to the host repo");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
