import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { accountIdOf, beginLogin, describeAccount, LoginCancelled, TokenStore, type Credentials } from "../auth.js";
import { resolveModels } from "../models.js";

function jwt(tag: string): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64({
    "https://api.openai.com/auth": { chatgpt_account_id: "acct-123", chatgpt_plan_type: "plus" },
    "https://api.openai.com/profile": { email: "me@example.com" },
    tag,
  })}.sig`;
}

let tokenServer: http.Server;
let tokenURL: string;
const tokenRequests: URLSearchParams[] = [];
let issued = 0;
let dir: string;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-provider-test-"));
  tokenServer = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const params = new URLSearchParams(raw);
      tokenRequests.push(params);
      if (params.get("refresh_token") === "revoked") {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_grant", error_description: "Refresh token revoked" }));
        return;
      }
      issued++;
      // Small delay so concurrent refreshes overlap.
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ access_token: jwt(`t${issued}`), refresh_token: `r${issued}`, expires_in: 3600 }));
      }, 50);
    });
  });
  await new Promise<void>((r) => tokenServer.listen(0, "127.0.0.1", () => r()));
  tokenURL = `http://127.0.0.1:${(tokenServer.address() as AddressInfo).port}/oauth/token`;
});

after(async () => {
  await new Promise<void>((r) => tokenServer.close(() => r()));
  fs.rmSync(dir, { recursive: true, force: true });
});

function storeWith(creds: Credentials | null, name: string): TokenStore {
  const store = new TokenStore(path.join(dir, `${name}.json`), tokenURL);
  if (creds) store.save(creds);
  return store;
}

const expiring = (): Credentials => ({ access: jwt("old"), refresh: "r0", expires: Date.now() + 1000, accountId: "acct-123" });

test("claims helpers: account id and description, no secrets", () => {
  const c: Credentials = { access: jwt("x"), refresh: "r", expires: 0, accountId: "acct-123" };
  assert.equal(accountIdOf(c.access), "acct-123");
  assert.equal(describeAccount(c), "me@example.com, plus plan");
  assert.equal(accountIdOf("not-a-jwt"), null);
});

test("TokenStore: fresh creds are returned untouched; file is 0600", async () => {
  const fresh: Credentials = { access: jwt("fresh"), refresh: "rf", expires: Date.now() + 3600_000, accountId: "acct-123" };
  const store = storeWith(fresh, "fresh");
  const before = tokenRequests.length;
  assert.deepEqual(await store.getValid(), fresh);
  assert.equal(tokenRequests.length, before);
  assert.equal(fs.statSync(store.file).mode & 0o777, 0o600);
  assert.equal(await storeWith(null, "missing").getValid(), null);
});

test("TokenStore: expiring creds refresh once even under concurrent callers", async () => {
  const store = storeWith(expiring(), "concurrent");
  const before = tokenRequests.length;
  const [a, b, c] = await Promise.all([store.getValid(), store.getValid(), store.getValid()]);
  assert.equal(tokenRequests.length - before, 1);
  assert.equal(tokenRequests.at(-1)!.get("grant_type"), "refresh_token");
  assert.equal(tokenRequests.at(-1)!.get("refresh_token"), "r0");
  assert.equal(a!.access, b!.access);
  assert.equal(b!.access, c!.access);
  assert.deepEqual(store.load(), a);
  assert.equal(fs.existsSync(`${store.file}.lock`), false, "lock released");
});

test("TokenStore: adopts a token another process already rotated in", async () => {
  const stale = expiring();
  const store = storeWith(stale, "rotated");
  const rotated: Credentials = { access: jwt("other-process"), refresh: "r-other", expires: Date.now() + 3600_000, accountId: "acct-123" };
  new TokenStore(store.file, tokenURL).save(rotated); // simulates a second agent-sh
  const before = tokenRequests.length;
  assert.deepEqual(await store.refresh(stale.access), rotated);
  assert.equal(tokenRequests.length, before, "no second refresh (would burn the rotated refresh token)");
});

test("TokenStore: revoked refresh token surfaces the OAuth error", async () => {
  const store = storeWith({ ...expiring(), refresh: "revoked" }, "revoked");
  await assert.rejects(store.getValid(), /token request failed \(400\): Refresh token revoked/);
});

test("beginLogin: PKCE URL, pasted redirect URL completes the exchange", async () => {
  const login = await beginLogin({ originator: "agent-sh", tokenURL, port: 0 });
  const url = new URL(login.url);
  assert.equal(url.origin + url.pathname, "https://auth.openai.com/oauth/authorize");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("redirect_uri"), "http://localhost:1455/auth/callback");
  assert.equal(url.searchParams.get("originator"), "agent-sh");
  assert.ok(login.callbackListening);
  const state = url.searchParams.get("state")!;

  assert.throws(() => login.supply("http://localhost:1455/auth/callback?code=abc&state=someone-else"), /different sign-in attempt/);
  login.supply(`http://localhost:1455/auth/callback?code=abc&state=${state}`);
  const creds = await login.result;
  assert.equal(creds.accountId, "acct-123");
  const exchange = tokenRequests.at(-1)!;
  assert.equal(exchange.get("grant_type"), "authorization_code");
  assert.equal(exchange.get("code"), "abc");
  assert.ok((exchange.get("code_verifier") ?? "").length >= 43);
});

test("beginLogin: cancel rejects with LoginCancelled", async () => {
  const login = await beginLogin({ originator: "agent-sh", tokenURL, port: 0 });
  login.cancel();
  await assert.rejects(login.result, (err) => err instanceof LoginCancelled);
});

test("resolveModels: settings list > Codex cache (listed only) > fallback", () => {
  const cache = path.join(dir, "models_cache.json");
  fs.writeFileSync(cache, JSON.stringify({ models: [
    { slug: "gpt-6-astra", visibility: "list", context_window: 272000, input_modalities: ["text", "image"] },
    { slug: "hidden-model", visibility: "hide" },
    { slug: "gpt-5.5", visibility: "list" },
  ] }));
  assert.deepEqual(resolveModels([], cache).map((m) => m.id), ["gpt-6-astra", "gpt-5.5"]);
  assert.equal(resolveModels([], cache)[0]!.echoReasoning, true);
  assert.deepEqual(resolveModels(["custom"], cache).map((m) => m.id), ["custom"]);
  assert.deepEqual(resolveModels([], path.join(dir, "nope.json")).map((m) => m.id), ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini"]);
});
