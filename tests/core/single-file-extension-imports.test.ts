/** Ratchet: bundled single-file extensions can't runtime-import agent-sh
 *  modules — they fail to resolve from ~/.agent-sh/extensions/ on fresh
 *  users. Type-only imports are erased by esbuild before the scan. */
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { transformSync } from "esbuild";

const BUNDLED_DIR = fileURLToPath(new URL("../../examples/extensions/", import.meta.url));

const KNOWN_OFFENDERS: ReadonlySet<string> = new Set([
  `interactive-prompts.ts: from "agent-sh/utils/diff-renderer.js"`,
  `interactive-prompts.ts: from "agent-sh/utils/box-frame.js"`,
  `interactive-prompts.ts: from "agent-sh/utils/palette.js"`,
  `interactive-prompts.ts: from "agent-sh/utils/diff.js"`,
  `questionnaire.ts: from "agent-sh/utils/palette.js"`,
  `overlay-agent.ts: from "agent-sh/utils/floating-panel"`,
  `overlay-agent.ts: from "agent-sh/utils/terminal-buffer"`,
  `subagents.ts: from "agent-sh/agent/subagent"`,
]);

test("bundled single-file extensions have no new runtime imports of agent-sh/*", () => {
  const seen = new Set<string>();
  const introduced: string[] = [];
  for (const entry of readdirSync(BUNDLED_DIR, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
    const src = readFileSync(join(BUNDLED_DIR, entry.name), "utf8");
    const { code } = transformSync(src, { loader: "ts", format: "esm" });
    for (const m of code.matchAll(/from\s+["'](agent-sh\/[^"']+)["']/g)) {
      const key = `${entry.name}: from "${m[1]}"`;
      seen.add(key);
      if (!KNOWN_OFFENDERS.has(key)) introduced.push(key);
    }
  }
  const cleared = [...KNOWN_OFFENDERS].filter((k) => !seen.has(k));

  assert.deepEqual(
    introduced, [],
    `New single-file extension has a runtime import of agent-sh/* — it will fail ` +
    `to load from ~/.agent-sh/extensions/ on fresh users. Use ctx.call(...) or ` +
    `convert to a directory extension.\n\nNew:\n  ${introduced.join("\n  ")}`,
  );
  assert.deepEqual(
    cleared, [],
    `KNOWN_OFFENDERS lists entries that no longer appear in the source — ` +
    `nice work, please remove them from KNOWN_OFFENDERS to keep the ratchet ` +
    `honest.\n\nCleared:\n  ${cleared.join("\n  ")}`,
  );
});
