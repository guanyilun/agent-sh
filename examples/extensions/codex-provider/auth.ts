/**
 * ChatGPT OAuth (PKCE) and a token store shared across processes.
 * Refresh tokens rotate, so refreshes take a file lock and re-read first.
 */
import { spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";

/** Public OAuth client of OpenAI's Codex CLI; the same flow pi and others use. */
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
export const TOKEN_URL = "https://auth.openai.com/oauth/token";
const CALLBACK_PORT = 1455;
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}/auth/callback`;
const SCOPE = "openid profile email offline_access";
const AUTH_CLAIM = "https://api.openai.com/auth";
const PROFILE_CLAIM = "https://api.openai.com/profile";
const REFRESH_MARGIN_MS = 5 * 60_000;
const LOGIN_TIMEOUT_MS = 10 * 60_000;
const LOCK_STALE_MS = 30_000;

export interface Credentials {
  access: string;
  refresh: string;
  /** Epoch ms. */
  expires: number;
  accountId: string;
}

export class LoginCancelled extends Error {
  constructor() { super("sign-in cancelled"); }
}

export function decodeJwtPayload(token: string): Record<string, any> | null {
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf-8"));
  } catch {
    return null;
  }
}

export function accountIdOf(accessToken: string): string | null {
  const id = decodeJwtPayload(accessToken)?.[AUTH_CLAIM]?.chatgpt_account_id;
  return typeof id === "string" && id ? id : null;
}

/** "me@example.com, plus plan" — for status lines; never includes secrets. */
export function describeAccount(creds: Credentials): string {
  const claims = decodeJwtPayload(creds.access) ?? {};
  const email = claims[PROFILE_CLAIM]?.email;
  const plan = claims[AUTH_CLAIM]?.chatgpt_plan_type;
  const parts = [email, plan && `${plan} plan`].filter((p): p is string => typeof p === "string" && !!p);
  return parts.length ? parts.join(", ") : `account ${creds.accountId.slice(0, 8)}…`;
}

async function requestTokens(params: Record<string, string>, tokenURL: string): Promise<Credentials> {
  const res = await fetch(tokenURL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CLIENT_ID, ...params }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`token request failed (${res.status})${oauthErrorSuffix(text)}`);
  const json = JSON.parse(text) as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (!json.access_token || !json.refresh_token || typeof json.expires_in !== "number") {
    throw new Error("token response is missing fields");
  }
  const accountId = accountIdOf(json.access_token);
  if (!accountId) throw new Error("token carries no ChatGPT account id");
  return {
    access: json.access_token,
    refresh: json.refresh_token,
    expires: Date.now() + json.expires_in * 1000,
    accountId,
  };
}

function oauthErrorSuffix(text: string): string {
  try {
    const j = JSON.parse(text) as { error?: unknown; error_description?: unknown };
    const msg = j.error_description ?? (typeof j.error === "string" ? j.error : undefined);
    return typeof msg === "string" && msg ? `: ${msg}` : "";
  } catch {
    return "";
  }
}

export class TokenStore {
  private inflight: Promise<Credentials | null> | null = null;

  constructor(readonly file: string, private readonly tokenURL = TOKEN_URL) {}

  load(): Credentials | null {
    try {
      const c = JSON.parse(fs.readFileSync(this.file, "utf-8")) as Partial<Credentials>;
      return typeof c.access === "string" && typeof c.refresh === "string"
        && typeof c.expires === "number" && typeof c.accountId === "string"
        ? (c as Credentials)
        : null;
    } catch {
      return null;
    }
  }

  save(creds: Credentials): void {
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(creds, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  clear(): void {
    fs.rmSync(this.file, { force: true });
  }

  async getValid(): Promise<Credentials | null> {
    const creds = this.load();
    if (!creds) return null;
    if (creds.expires - Date.now() > REFRESH_MARGIN_MS) return creds;
    return this.refresh(creds.access);
  }

  /** Skips the refresh if another process already rotated the token. */
  refresh(staleAccess: string): Promise<Credentials | null> {
    this.inflight ??= this.refreshLocked(staleAccess).finally(() => { this.inflight = null; });
    return this.inflight;
  }

  private async refreshLocked(staleAccess: string): Promise<Credentials | null> {
    const release = await acquireLock(`${this.file}.lock`);
    try {
      const current = this.load();
      if (!current) return null;
      if (current.access !== staleAccess && current.expires - Date.now() > REFRESH_MARGIN_MS) return current;
      const next = await requestTokens({ grant_type: "refresh_token", refresh_token: current.refresh }, this.tokenURL);
      this.save(next);
      return next;
    } finally {
      release();
    }
  }
}

async function acquireLock(lockPath: string, timeoutMs = 15_000): Promise<() => void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      fs.closeSync(fs.openSync(lockPath, "wx"));
      return () => fs.rmSync(lockPath, { force: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    try {
      if (Date.now() - fs.statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
        fs.rmSync(lockPath, { force: true });
        continue;
      }
    } catch {
      continue; // lock vanished between open and stat — retry now
    }
    if (Date.now() > deadline) throw new Error("timed out waiting for another process's token refresh");
    await new Promise((r) => setTimeout(r, 100));
  }
}

export interface PendingLogin {
  url: string;
  /** False when port 1455 was busy: the user must paste the redirect URL. */
  callbackListening: boolean;
  /** Resolves after the code is exchanged. */
  result: Promise<Credentials>;
  /** Accept a pasted redirect URL (or bare code). Throws on a foreign state. */
  supply: (input: string) => void;
  cancel: () => void;
}

export async function beginLogin(opts: {
  originator: string;
  tokenURL?: string;
  /** Callback listen port; tests pass 0. The redirect URI stays :1455. */
  port?: number;
}): Promise<PendingLogin> {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const state = crypto.randomBytes(16).toString("hex");

  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("scope", SCOPE);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("id_token_add_organizations", "true");
  url.searchParams.set("codex_cli_simplified_flow", "true");
  url.searchParams.set("originator", opts.originator);

  let resolveCode!: (code: string) => void;
  let rejectCode!: (err: Error) => void;
  const code = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://localhost");
    if (u.pathname !== "/auth/callback") {
      res.writeHead(404).end();
      return;
    }
    const oauthError = u.searchParams.get("error");
    if (oauthError) {
      const message = u.searchParams.get("error_description") ?? oauthError;
      page(res, 400, `Sign-in failed: ${message}`);
      rejectCode(new Error(message));
      return;
    }
    if (u.searchParams.get("state") !== state) {
      page(res, 400, "This sign-in link is from a different attempt. Run /codex-login again.");
      return;
    }
    const c = u.searchParams.get("code");
    if (!c) {
      page(res, 400, "Missing authorization code.");
      return;
    }
    page(res, 200, "Signed in to ChatGPT. You can close this tab and return to agent-sh.");
    resolveCode(c);
  });
  const callbackListening = await new Promise<boolean>((resolve) => {
    server.once("error", () => resolve(false));
    server.listen(opts.port ?? CALLBACK_PORT, "127.0.0.1", () => resolve(true));
  });

  const timer = setTimeout(() => rejectCode(new Error("timed out waiting for sign-in")), LOGIN_TIMEOUT_MS);
  timer.unref();
  const result = code
    .then((c) => requestTokens(
      { grant_type: "authorization_code", code: c, code_verifier: verifier, redirect_uri: REDIRECT_URI },
      opts.tokenURL ?? TOKEN_URL,
    ))
    .finally(() => {
      clearTimeout(timer);
      server.close(() => {});
    });

  return {
    url: url.toString(),
    callbackListening,
    result,
    supply(input) {
      const parsed = parseRedirect(input);
      if (parsed.state && parsed.state !== state) throw new Error("that URL is from a different sign-in attempt");
      if (!parsed.code) throw new Error("no authorization code found in that input");
      resolveCode(parsed.code);
    },
    cancel() {
      rejectCode(new LoginCancelled());
    },
  };
}

function parseRedirect(input: string): { code?: string; state?: string } {
  const value = input.trim();
  try {
    const u = new URL(value);
    return { code: u.searchParams.get("code") ?? undefined, state: u.searchParams.get("state") ?? undefined };
  } catch { /* not a URL */ }
  if (value.includes("code=")) {
    const p = new URLSearchParams(value.replace(/^\?/, ""));
    return { code: p.get("code") ?? undefined, state: p.get("state") ?? undefined };
  }
  return { code: value || undefined };
}

function page(res: http.ServerResponse, status: number, message: string): void {
  const safe = message.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><meta charset="utf-8"><title>agent-sh</title>`
    + `<body style="font:16px system-ui;margin:3rem"><p>${safe}</p></body>`);
}

export function openBrowser(url: string): void {
  const [cmd, args] = process.platform === "darwin" ? ["open", [url]]
    : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
    : ["xdg-open", [url]];
  try {
    spawn(cmd, args as string[], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
  } catch { /* the URL is also printed for manual use */ }
}
