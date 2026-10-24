import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import { once } from "node:events";
import activate from "../../../../src/agent/extensions/codex-provider/index.js";
import type { ExtensionContext } from "../../../../src/shell/host-types.js";

test("built-in activation honors configured header deadlines", { timeout: 5000 }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-config-"));
  await fs.writeFile(path.join(dir, "auth.json"), JSON.stringify({ access: "fake", refresh: "fake", accountId: "fake", expires: Date.now() + 3600000 }));
  let calls = 0;
  const upstream = http.createServer(req => { calls++; req.resume(); });
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
  const cleanups: Array<() => void> = [];
  let registration: { apiKey: string; baseURL: string } | undefined;
  t.after(async () => {
    cleanups.forEach(close => close());
    upstream.closeAllConnections();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
    await fs.rm(dir, { recursive: true, force: true });
  });
  await activate({
    getExtensionSettings: (_name: string, defaults: object) => ({ ...defaults, models: ["test-model"], headersTimeoutMs: 80,
      upstreamURL: `http://127.0.0.1:${(upstream.address() as { port: number }).port}/responses` }),
    getStoragePath: () => dir,
    onDispose: (fn: () => void) => cleanups.push(fn),
    agent: { providers: { configure() {}, register: (reg: typeof registration) => { registration = reg; return () => {}; } } },
    registerCommand() {}, bus: { emit() {} },
  } as unknown as ExtensionContext);
  assert(registration);
  const response = await fetch(registration.baseURL + "/chat/completions", {
    method: "POST", headers: { authorization: `Bearer ${registration.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "test-model", messages: [{ role: "user", content: "hello" }], stream: true }),
    signal: AbortSignal.timeout(1000),
  });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /waiting for response headers after 0.08s/);
  assert.equal(calls, 1);
});
