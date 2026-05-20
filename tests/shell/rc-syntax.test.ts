/**
 * `<shell> -n` syntax check on the rc file each strategy generates.
 *
 * Catches "we generated syntactically broken shell" regressions cheaply —
 * the shell parses the rc but does not execute it. Skips for any shell
 * not installed on the host.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { bashStrategy } from "../../src/shell/strategies/bash.js";
import { zshStrategy } from "../../src/shell/strategies/zsh.js";
import { fishStrategy } from "../../src/shell/strategies/fish.js";
import type { ShellStrategy } from "../../src/shell/strategies/index.js";

interface Spec {
  strategy: ShellStrategy;
  candidates: string[];
  rcFilename: string;
}

const SHELLS: Spec[] = [
  { strategy: bashStrategy, rcFilename: ".bashrc",   candidates: ["/bin/bash", "/usr/bin/bash", "/usr/local/bin/bash", "/opt/homebrew/bin/bash"] },
  { strategy: zshStrategy,  rcFilename: ".zshrc",    candidates: ["/bin/zsh",  "/usr/bin/zsh",  "/usr/local/bin/zsh",  "/opt/homebrew/bin/zsh"] },
  { strategy: fishStrategy, rcFilename: "init.fish", candidates: ["/usr/bin/fish", "/usr/local/bin/fish", "/opt/homebrew/bin/fish"] },
];

function findBinary(candidates: string[]): string | null {
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isFile()) return c;
    } catch { /* try next */ }
  }
  return null;
}

for (const spec of SHELLS) {
  const bin = findBinary(spec.candidates);
  const skipReason = bin === null ? `${spec.strategy.name} not installed on this host` : false;

  test(`${spec.strategy.name}: generated rc passes \`${spec.strategy.name} -n\` syntax check`, { skip: skipReason }, () => {
    const tmpDirRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-sh-rc-syntax-"));
    try {
      const cfg = spec.strategy.prepareSpawn({
        tmpDirRoot,
        instanceTag: "id=deadbeef",
        showIndicator: true,
        userHome: process.env.HOME || os.homedir(),
        env: { HOME: process.env.HOME || os.homedir() },
      });

      const rcPath = path.join(cfg.tmpDir!, spec.rcFilename);
      assert.ok(fs.existsSync(rcPath), `expected ${rcPath} to exist`);

      const result = spawnSync(bin!, ["-n", rcPath], { encoding: "utf8" });
      assert.equal(
        result.status,
        0,
        `${spec.strategy.name} -n failed:\nstdout: ${result.stdout}\nstderr: ${result.stderr}\nrc file:\n${fs.readFileSync(rcPath, "utf8")}`,
      );

      if (cfg.tmpDir) fs.rmSync(cfg.tmpDir, { recursive: true, force: true });
    } finally {
      fs.rmSync(tmpDirRoot, { recursive: true, force: true });
    }
  });

  test(`${spec.strategy.name}: rc still passes syntax check with showIndicator=false`, { skip: skipReason }, () => {
    const tmpDirRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-sh-rc-syntax-"));
    try {
      const cfg = spec.strategy.prepareSpawn({
        tmpDirRoot,
        instanceTag: "id=deadbeef",
        showIndicator: false,
        userHome: process.env.HOME || os.homedir(),
        env: { HOME: process.env.HOME || os.homedir() },
      });
      const rcPath = path.join(cfg.tmpDir!, spec.rcFilename);
      const result = spawnSync(bin!, ["-n", rcPath], { encoding: "utf8" });
      assert.equal(result.status, 0, `stderr: ${result.stderr}`);
      if (cfg.tmpDir) fs.rmSync(cfg.tmpDir, { recursive: true, force: true });
    } finally {
      fs.rmSync(tmpDirRoot, { recursive: true, force: true });
    }
  });
}
