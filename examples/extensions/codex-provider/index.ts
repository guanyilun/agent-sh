/** codex-provider: ChatGPT (Codex) subscription as an ash provider via a loopback proxy. See README.md. */
import * as crypto from "node:crypto";
import * as path from "node:path";
import type { ExtensionContext } from "agent-sh/types";
import { beginLogin, describeAccount, LoginCancelled, openBrowser, TokenStore, type PendingLogin } from "./auth.js";
import { resolveModels } from "./models.js";
import { SESSION_HEADER, startProxy } from "./proxy.js";

const DEFAULT_UPSTREAM = "https://chatgpt.com/backend-api/codex/responses";

export default async function activate(ctx: ExtensionContext): Promise<void> {
  const agent = ctx.agent;
  if (!agent) return; // no ash host

  const config = ctx.getExtensionSettings("codex-provider", {
    providerId: "codex",
    /** Override the model list (default: the Codex client's cache). */
    models: [] as string[],
    upstreamURL: DEFAULT_UPSTREAM,
    originator: "agent-sh",
  });
  const store = new TokenStore(path.join(ctx.getStoragePath("codex-provider"), "auth.json"));
  const secret = crypto.randomBytes(24).toString("hex");

  const proxy = await startProxy({
    secret,
    upstreamURL: config.upstreamURL,
    originator: config.originator,
    getCredentials: () => store.getValid(),
    refreshCredentials: (stale) => store.refresh(stale),
  });
  ctx.onDispose(() => { void proxy.close(); });

  const id = config.providerId;
  const models = resolveModels(config.models);
  agent.providers.configure(id, {
    // "off" = server default effort
    reasoningParams: (level) => (level === "off" ? {} : { reasoning_effort: level }),
    requestHeaders: ({ sessionId }): Record<string, string> => (sessionId ? { [SESSION_HEADER]: sessionId } : {}),
  });
  ctx.onDispose(agent.providers.register({
    id,
    apiKey: secret,
    baseURL: proxy.baseURL,
    defaultModel: models[0]?.id,
    models,
    supportsReasoningEffort: true,
  }));

  const info = (message: string) => ctx.bus.emit("ui:info", { message });
  const error = (message: string) => ctx.bus.emit("ui:error", { message });
  let pending: PendingLogin | null = null;

  ctx.registerCommand("codex-login", "Sign in with your ChatGPT account (Codex subscription)", async (args: string) => {
    const pasted = args.trim();
    if (pasted) {
      if (!pending) return error("codex-login: no sign-in in progress. Run /codex-login first.");
      try {
        pending.supply(pasted);
      } catch (err) {
        error(`codex-login: ${(err as Error).message}`);
      }
      return;
    }

    pending?.cancel();
    const login = await beginLogin({ originator: config.originator });
    pending = login;
    info(`codex-login: sign in at ${login.url}`);
    openBrowser(login.url);
    if (!login.callbackListening) {
      info("codex-login: port 1455 is busy (another sign-in running?), so the browser can't hand back the code. "
        + "After signing in, copy the final URL from the address bar and run /codex-login <url>.");
    }
    login.result.then(
      (creds) => {
        store.save(creds);
        info(`codex-login: signed in (${describeAccount(creds)}). Provider "${id}" is ready.`);
      },
      (err) => {
        if (!(err instanceof LoginCancelled)) error(`codex-login: ${(err as Error).message}`);
      },
    ).finally(() => {
      if (pending === login) pending = null;
    });
  });

  ctx.registerCommand("codex-logout", "Forget the stored ChatGPT sign-in", () => {
    pending?.cancel();
    store.clear();
    info("codex-logout: signed out. Codex requests will fail until /codex-login.");
  });

  ctx.registerCommand("codex-status", "Show ChatGPT sign-in and Codex provider status", () => {
    const creds = store.load();
    const account = creds
      ? `signed in (${describeAccount(creds)}); access token ${creds.expires > Date.now() ? "valid until" : "expired at"} `
        + `${new Date(creds.expires).toLocaleString()}, refreshed automatically`
      : "not signed in. Run /codex-login";
    info(`codex-status: ${account}\n  provider "${id}" → ${proxy.baseURL}\n  models: ${models.map((m) => m.id).join(", ")}`);
  });
}
