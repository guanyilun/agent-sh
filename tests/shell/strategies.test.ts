import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  pickStrategy,
  SUPPORTED_SHELL_NAMES,
  FALLBACK_STRATEGY,
} from "../../src/shell/strategies/index.js";
import { bashStrategy } from "../../src/shell/strategies/bash.js";
import { zshStrategy } from "../../src/shell/strategies/zsh.js";
import { fishStrategy } from "../../src/shell/strategies/fish.js";
import type { PrepareSpawnOpts } from "../../src/shell/strategies/types.js";

function makeOpts(overrides: Partial<PrepareSpawnOpts> = {}): PrepareSpawnOpts {
  const tmpDirRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-sh-strategies-test-"));
  return {
    tmpDirRoot,
    instanceTag: "id=deadbeef",
    showIndicator: true,
    userHome: "/home/test",
    env: { HOME: "/home/test" },
    ...overrides,
  };
}

function cleanup(tmpDir: string | undefined): void {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ── pickStrategy / supported names ───────────────────────────────

test("pickStrategy returns the bash strategy for any path ending in bash", () => {
  assert.equal(pickStrategy("/bin/bash")?.name, "bash");
  assert.equal(pickStrategy("/usr/local/bin/bash")?.name, "bash");
  assert.equal(pickStrategy("/opt/homebrew/bin/bash")?.name, "bash");
});

test("pickStrategy returns the zsh strategy for any path ending in zsh", () => {
  assert.equal(pickStrategy("/bin/zsh")?.name, "zsh");
  assert.equal(pickStrategy("/usr/local/bin/zsh")?.name, "zsh");
});

test("pickStrategy returns the fish strategy for any path ending in fish", () => {
  assert.equal(pickStrategy("/usr/local/bin/fish")?.name, "fish");
  assert.equal(pickStrategy("/opt/homebrew/bin/fish")?.name, "fish");
});

test("pickStrategy returns null for unrecognized shells", () => {
  assert.equal(pickStrategy("/usr/bin/nu"), null);
  assert.equal(pickStrategy("/usr/bin/pwsh"), null);
  assert.equal(pickStrategy("/bin/sh"), null);
});

test("SUPPORTED_SHELL_NAMES lists all three first-class shells", () => {
  assert.deepEqual([...SUPPORTED_SHELL_NAMES].sort(), ["bash", "fish", "zsh"]);
});

test("FALLBACK_STRATEGY is bash (used when the requested shell is unknown)", () => {
  assert.equal(FALLBACK_STRATEGY.name, "bash");
});

// ── bash strategy ────────────────────────────────────────────────

test("bash strategy writes a .bashrc that sources the user's bashrc and installs all three OSC hooks", () => {
  const opts = makeOpts();
  const cfg = bashStrategy.prepareSpawn(opts);
  try {
    assert.ok(cfg.tmpDir);
    const rc = fs.readFileSync(path.join(cfg.tmpDir!, ".bashrc"), "utf8");

    assert.match(rc, /source "\/home\/test\/\.bashrc"/);
    assert.match(rc, /\\e\]9999;id=deadbeef;PROMPT\\a/);
    assert.match(rc, /\\e\]9997;id=deadbeef;%s\\a/);
    assert.match(rc, /\\e\]9998;id=deadbeef;READY\\a/);
    assert.match(rc, /PROMPT_COMMAND=/);
    assert.match(rc, /trap '__agent_sh_emit_preexec' DEBUG/);
    assert.match(rc, /redraw-current-line/);
  } finally {
    cleanup(cfg.tmpDir);
    cleanup(opts.tmpDirRoot);
  }
});

test("bash strategy spawn args use --rcfile pointing at the tmp .bashrc", () => {
  const opts = makeOpts();
  const cfg = bashStrategy.prepareSpawn(opts);
  try {
    assert.equal(cfg.args[0], "--rcfile");
    assert.equal(cfg.args[1], path.join(cfg.tmpDir!, ".bashrc"));
    assert.deepEqual(cfg.envOverrides, {});
  } finally {
    cleanup(cfg.tmpDir);
    cleanup(opts.tmpDirRoot);
  }
});

test("bash strategy omits the title indicator when showIndicator is false", () => {
  const opts = makeOpts({ showIndicator: false });
  const cfg = bashStrategy.prepareSpawn(opts);
  try {
    const rc = fs.readFileSync(path.join(cfg.tmpDir!, ".bashrc"), "utf8");
    assert.doesNotMatch(rc, /agent-sh:/);
  } finally {
    cleanup(cfg.tmpDir);
    cleanup(opts.tmpDirRoot);
  }
});

test("bash strategy substitutes a different instance tag per call (nested instances)", () => {
  const a = bashStrategy.prepareSpawn(makeOpts({ instanceTag: "id=aaaaaa" }));
  const b = bashStrategy.prepareSpawn(makeOpts({ instanceTag: "id=bbbbbb" }));
  try {
    const rcA = fs.readFileSync(path.join(a.tmpDir!, ".bashrc"), "utf8");
    const rcB = fs.readFileSync(path.join(b.tmpDir!, ".bashrc"), "utf8");
    assert.match(rcA, /id=aaaaaa/);
    assert.doesNotMatch(rcA, /id=bbbbbb/);
    assert.match(rcB, /id=bbbbbb/);
    assert.doesNotMatch(rcB, /id=aaaaaa/);
  } finally {
    cleanup(a.tmpDir);
    cleanup(b.tmpDir);
  }
});

test("bash envCaptureCommand sources bashrc then runs env -0", () => {
  assert.match(bashStrategy.envCaptureCommand(), /source ~\/\.bashrc/);
  assert.match(bashStrategy.envCaptureCommand(), /env -0/);
});

test("bash redrawEscape returns the CSI 9999~ sequence", () => {
  assert.equal(bashStrategy.redrawEscape(), "\x1b[9999~");
});

// ── zsh strategy ─────────────────────────────────────────────────

test("zsh strategy writes a .zshrc that sources the user's zshrc and installs all three OSC hooks", () => {
  const opts = makeOpts({ env: { HOME: "/home/test", ZDOTDIR: "/home/test/.config/zsh" } });
  const cfg = zshStrategy.prepareSpawn(opts);
  try {
    const rc = fs.readFileSync(path.join(cfg.tmpDir!, ".zshrc"), "utf8");
    assert.match(rc, /ZDOTDIR="\/home\/test\/\.config\/zsh"/);
    assert.match(rc, /source "\/home\/test\/\.config\/zsh\/\.zshrc"/);
    assert.match(rc, /\\e\]9999;id=deadbeef;PROMPT\\a/);
    assert.match(rc, /\\e\]9997;id=deadbeef;%s\\a/);
    assert.match(rc, /\\e\]9998;id=deadbeef;READY\\a/);
    assert.match(rc, /precmd_functions\+=\(__agent_sh_precmd\)/);
    assert.match(rc, /preexec_functions\+=\(__agent_sh_preexec\)/);
    assert.match(rc, /zle -N __agent_sh_redraw/);
  } finally {
    cleanup(cfg.tmpDir);
    cleanup(opts.tmpDirRoot);
  }
});

test("zsh strategy spawn config sets ZDOTDIR to the tmp dir and uses --no-globalrcs", () => {
  const opts = makeOpts();
  const cfg = zshStrategy.prepareSpawn(opts);
  try {
    assert.deepEqual(cfg.args, ["--no-globalrcs"]);
    assert.equal(cfg.envOverrides.ZDOTDIR, cfg.tmpDir);
  } finally {
    cleanup(cfg.tmpDir);
    cleanup(opts.tmpDirRoot);
  }
});

test("zsh strategy falls back to HOME when ZDOTDIR is unset", () => {
  const opts = makeOpts({ env: { HOME: "/home/other" } });
  const cfg = zshStrategy.prepareSpawn(opts);
  try {
    const rc = fs.readFileSync(path.join(cfg.tmpDir!, ".zshrc"), "utf8");
    assert.match(rc, /ZDOTDIR="\/home\/other"/);
    assert.match(rc, /source "\/home\/other\/\.zshrc"/);
  } finally {
    cleanup(cfg.tmpDir);
    cleanup(opts.tmpDirRoot);
  }
});

test("zsh strategy chains onto an existing zle-line-init widget rather than clobbering it", () => {
  const cfg = zshStrategy.prepareSpawn(makeOpts());
  try {
    const rc = fs.readFileSync(path.join(cfg.tmpDir!, ".zshrc"), "utf8");
    assert.match(rc, /if \(\( \$\{\+widgets\[zle-line-init\]\} \)\); then/);
    assert.match(rc, /zle -A zle-line-init __agent_sh_orig_line_init/);
  } finally {
    cleanup(cfg.tmpDir);
  }
});

test("zsh envCaptureCommand sources zshrc then runs env -0", () => {
  assert.match(zshStrategy.envCaptureCommand(), /source ~\/\.zshrc/);
  assert.match(zshStrategy.envCaptureCommand(), /env -0/);
});

test("zsh redrawEscape returns the CSI 9999~ sequence", () => {
  assert.equal(zshStrategy.redrawEscape(), "\x1b[9999~");
});

// ── fish strategy ────────────────────────────────────────────────

test("fish strategy writes an init.fish that installs all three OSC hooks via event handlers", () => {
  const cfg = fishStrategy.prepareSpawn(makeOpts());
  try {
    const init = fs.readFileSync(path.join(cfg.tmpDir!, "init.fish"), "utf8");
    assert.match(init, /__agent_sh_precmd --on-event fish_prompt/);
    assert.match(init, /__agent_sh_preexec --on-event fish_preexec/);
    assert.match(init, /\\e\]9999;id=deadbeef;PROMPT\\a/);
    assert.match(init, /\\e\]9997;id=deadbeef;%s\\a/);
    assert.match(init, /\\e\]9998;id=deadbeef;READY\\a/);
  } finally {
    cleanup(cfg.tmpDir);
  }
});

test("fish strategy spawn config layers init via `-l -i -C source <init>`", () => {
  const cfg = fishStrategy.prepareSpawn(makeOpts());
  try {
    assert.deepEqual(cfg.args.slice(0, 3), ["-l", "-i", "-C"]);
    assert.equal(cfg.args[3], `source ${path.join(cfg.tmpDir!, "init.fish")}`);
    assert.deepEqual(cfg.envOverrides, {});
  } finally {
    cleanup(cfg.tmpDir);
  }
});

test("fish strategy chains onto an existing fish_prompt rather than clobbering it", () => {
  const cfg = fishStrategy.prepareSpawn(makeOpts());
  try {
    const init = fs.readFileSync(path.join(cfg.tmpDir!, "init.fish"), "utf8");
    assert.match(init, /functions --copy fish_prompt __agent_sh_orig_fish_prompt/);
    assert.match(init, /__agent_sh_orig_fish_prompt/);
  } finally {
    cleanup(cfg.tmpDir);
  }
});

test("fish envCaptureCommand just runs env -0 (fish -l sources config itself)", () => {
  assert.equal(fishStrategy.envCaptureCommand(), "env -0");
});

test("fish redrawEscape returns the CSI-u sequence with private-use codepoint U+E028", () => {
  assert.equal(fishStrategy.redrawEscape(), "\x1b[57400u");
});
