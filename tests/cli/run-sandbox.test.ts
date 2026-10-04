/** The sandbox extension under `agent-sh run`: the built CLI against a local fake OpenAI-compatible server. */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { fakeLlm, runCli, SANDBOX, SUBAGENTS, toolCall } from "./fake-llm.js";

const EXTENSIONS = ["-e", SUBAGENTS, "-e", SANDBOX];
const NO_OS_SANDBOX = { SBX_BWRAP: "/nonexistent/bwrap", SBX_SANDBOX_EXEC: "/nonexistent/sandbox-exec", SBX_LANDLOCK: "off" };
const write = (home: string, rel: string, text: string) => {
  mkdirSync(join(home, rel, ".."), { recursive: true });
  writeFileSync(join(home, rel), text);
};
/** The model calls one tool, then reports what the tool said. */
const callsTool = (name: string, args: Record<string, unknown>) => fakeLlm((req) => {
  const tool = req.messages.find((m) => m.role === "tool");
  return tool ? { content: `tool said: ${tool.content}` } : toolCall(name, args);
});

test("config.sandbox arms the guard: a write outside the allowed dirs is blocked", async () => {
  const llm = await callsTool("write_file", { path: "/tmp/agent-sh-run-test-outside.txt", content: "x" });
  try {
    const r = await runCli(["run", "campaign.ts", ...EXTENSIONS], llm.url, {
      prepare: (home) => write(home, "campaign.ts", [
        'export const config = { sandbox: { write: ["./out"], os: "off" } };',
        'export default async ({ run }) => run({ task: "write a file", tools: ["write_file"] });',
      ].join("\n")),
    });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /sandbox guard armed \(write roots: .*\/out; hidden: 0; policy: none; os sandbox: off\)/);
    assert.match(r.stdout, /tool said: Error: Blocked by sandbox guard: writes are limited to .*\/out/);
    assert.ok(!existsSync("/tmp/agent-sh-run-test-outside.txt"));
  } finally { llm.server.close(); }
});

for (const [name, sandbox, extensions, env, message] of [
  ["config.sandbox without the sandbox extension", "{ write: [] }", ["-e", SUBAGENTS], {}, /config\.sandbox is set but nothing handles it/],
  ["an option the sandbox doesn't have", '{ writes: ["./out"], os: "off" }', EXTENSIONS, {}, /config\.sandbox\.writes isn't a sandbox option/],
  ["os: \"required\" without an OS sandbox", '{ os: "required" }', EXTENSIONS, NO_OS_SANDBOX, /"required" but no OS sandbox is usable here/],
  ["net: false (the run itself needs the model)", '{ net: false, os: "off" }', EXTENSIONS, {}, /net: false isn't supported yet: the run itself needs the network to reach the model/],
] as const) {
  test(`refuses to start, before any model call: ${name}`, async () => {
    const llm = await fakeLlm(() => ({ content: "ok" }));
    try {
      const r = await runCli(["run", "campaign.ts", ...extensions], llm.url, {
        env,
        prepare: (home) => write(home, "campaign.ts", `export const config = { sandbox: ${sandbox} };\nexport default async ({ run }) => run({ task: "t", tools: [] });\n`),
      });
      assert.equal(r.code, 2, r.stderr);
      assert.match(r.stderr, message);
      assert.equal(llm.requests.length, 0);
    } finally { llm.server.close(); }
  });
}

test("os: \"preferred\" without an OS sandbox runs with the guard only, and says so", async () => {
  const llm = await fakeLlm(() => ({ content: "ok" }));
  try {
    const r = await runCli(["run", "campaign.ts", ...EXTENSIONS], llm.url, {
      env: NO_OS_SANDBOX,
      prepare: (home) => write(home, "campaign.ts", 'export const config = { sandbox: { write: ["./out"] } };\nexport default async ({ run }) => run({ task: "t", tools: [] });\n'),
    });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /no OS sandbox \(.*\); running with the guard only\./);
  } finally { llm.server.close(); }
});

test("config.sandbox.policy adds its rules: a forbidden command is blocked, and allowed without the policy", async () => {
  const llm = await callsTool("bash", { command: "squeue -u someone" });
  try {
    const campaign = (policy: string) => `export const config = { sandbox: { write: ["./out"], os: "off"${policy} } };\nexport default async ({ run }) => run(null, "check jobs", { tools: ["bash"] });\n`;
    const rules = JSON.stringify({ forbid: [{ regex: "(^|\\s)squeue\\b", message: "agents don't use the scheduler" }] });
    const withPolicy = await runCli(["run", "campaign.ts", ...EXTENSIONS], llm.url, {
      prepare: (h) => { write(h, "rules.json", rules); write(h, "campaign.ts", campaign(', policy: "./rules.json"')); },
    });
    assert.equal(withPolicy.code, 0, withPolicy.stderr);
    assert.match(withPolicy.stderr, /policy: .*rules\.json/);
    assert.match(withPolicy.stdout, /tool said: Error: Blocked by sandbox guard: agents don't use the scheduler/);

    const without = await runCli(["run", "campaign.ts", ...EXTENSIONS], llm.url, { prepare: (h) => write(h, "campaign.ts", campaign("")) });
    assert.equal(without.code, 0, without.stderr);
    assert.doesNotMatch(without.stdout, /Blocked by sandbox guard/);
  } finally { llm.server.close(); }
});

test("SBX_GUARD=1 arms the guard for callers that start agent-sh themselves; without it the extension does nothing", async () => {
  const llm = await callsTool("write_file", { path: "/tmp/agent-sh-run-test-outside.txt", content: "x" });
  try {
    const rules = JSON.stringify({ forbid: [{ regex: "x^", message: "never matches" }] });
    const armed = await runCli(["-p", "write a file", "--output", "json", "-e", SANDBOX], llm.url, {
      env: { SBX_GUARD: "1", SBX_WRITE_ROOTS: "/w/out:/w/tmp", SBX_HIDE: "/w/private", SBX_POLICY: "rules.json" },
      prepare: (home) => write(home, "rules.json", rules),
    });
    assert.equal(armed.code, 0, armed.stderr);
    assert.match(armed.stdout, /sandbox guard armed \(write roots: \/w\/out:\/w\/tmp; hidden: 1; policy: rules\.json; os sandbox: off\)/);
    assert.match(armed.stdout, /Blocked by sandbox guard: writes are limited to \/w\/out:\/w\/tmp/);
    assert.ok(!existsSync("/tmp/agent-sh-run-test-outside.txt"));

    const plain = await fakeLlm(() => ({ content: "hi" }));
    try {
      const inert = await runCli(["-p", "say hi", "--output", "json", "-e", SANDBOX], plain.url, { env: { SBX_WRITE_ROOTS: "/w/out" } });
      assert.equal(inert.code, 0, inert.stderr);
      assert.doesNotMatch(inert.stdout, /sandbox guard/);
    } finally { plain.server.close(); }
  } finally { llm.server.close(); }
});

const landlockHere = process.platform === "linux"
  && spawnSync("python3", ["-B", join(SANDBOX, "landlock.py"), "--probe"]).status === 0;

// The hidden path is split with '' so the guard can't recognise it.
for (const [name, skip, env, kind, denied] of [
  ["on macOS, Seatbelt", process.platform !== "darwin", {}, "seatbelt", /Operation not permitted/],
  ["on Linux without bubblewrap, Landlock", !landlockHere, { SBX_BWRAP: "/nonexistent/bwrap" }, "landlock", /Permission denied/],
] as const) {
  test(`${name} stops what the guard can't: bash writes outside and disguised reads of hidden paths`, { skip }, async () => {
    // Outside the temp dirs, which these sandboxes leave writable by design.
    const ws = mkdtempSync(join(fileURLToPath(new URL("../..", import.meta.url)), ".sbx-test-"));
    const disguised = join(ws, "priv''ate", "secret.txt");
    const llm = await callsTool("bash", { command: `echo x > ${ws}/outside.txt; echo y > ${ws}/out/inside.txt; cat ${disguised}; echo done` });
    try {
      mkdirSync(join(ws, "private"));
      writeFileSync(join(ws, "private", "secret.txt"), "TOPSECRET");
      writeFileSync(join(ws, "campaign.ts"), [
        'export const config = { sandbox: { write: ["./out"], hide: ["./private"] } };',
        'export default async ({ run }) => run(null, "do it", { tools: ["bash"] });',
      ].join("\n"));
      const r = await runCli(["run", join(ws, "campaign.ts"), ...EXTENSIONS], llm.url, { env });
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stderr, new RegExp(`os sandbox: on \\(${kind}\\)`));
      assert.ok(!existsSync(join(ws, "outside.txt")), "write outside the write dirs was blocked");
      assert.ok(existsSync(join(ws, "out", "inside.txt")), "write inside the write dirs worked");
      assert.match(r.stdout, denied);
      assert.doesNotMatch(r.stdout, /TOPSECRET/);
    } finally {
      llm.server.close();
      rmSync(ws, { recursive: true, force: true });
    }
  });
}
