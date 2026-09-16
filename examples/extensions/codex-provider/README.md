# codex-provider

Use your ChatGPT subscription (the same sign-in the Codex app uses) as a provider for agent-sh's built-in agent, `ash`. It works under both `agent-sh` and `ashi`, and ash keeps its own tools and extensions. No OpenAI API key is needed.

## Install

For development, symlink the extension so edits take effect on the next launch or `/reload`:

```bash
ln -s "$PWD/examples/extensions/codex-provider" ~/.agent-sh/extensions/codex-provider
```

For a plain copy instead: `agent-sh install ./examples/extensions/codex-provider`.

Then make it the default provider in `~/.agent-sh/settings.json`:

```json
{ "defaultProvider": "codex" }
```

## Use

```
/codex-login      # opens the browser; sign in with your ChatGPT account
/codex-status     # account, plan, token expiry, models
/model <id>       # e.g. /model gpt-5.5
/thinking high    # maps to Codex reasoning effort (off = server default)
/codex-logout
```

If port 1455 is busy (for example, another sign-in is open), finish signing in in the browser. Then copy the final URL from the address bar and run `/codex-login <url>`.

## How it works

```
ash (OpenAI SDK, Chat Completions)
  → 127.0.0.1:<random>/v1/chat/completions   (per-process secret as the API key)
  → chatgpt.com/backend-api/codex/responses  (Responses API, ChatGPT OAuth bearer)
```

- **Translation** (`translate.ts`): converts chat messages, tools and images to a Responses `input`. The Responses SSE stream comes back as chat chunks: content, `reasoning` for the thinking display, tool calls and usage (including cached tokens).
- **Reasoning continuity**: requests use `store: false`. Each encrypted reasoning item comes back to ash as a `reasoning_details` entry. ash echoes it on the next turn because the models are registered with `echoReasoning: true`, and the proxy converts it back into a reasoning input item. That way the model keeps its reasoning across tool calls.
- **Auth** (`auth.ts`): the same PKCE flow as the Codex CLI. Tokens are stored in `~/.agent-sh/codex-provider/auth.json` (mode 0600) and refreshed shortly before they expire. Refresh tokens rotate, so refreshes take a lock file and re-read the store, which lets several agent-sh processes share one sign-in. On an upstream 401, the proxy refreshes once and retries.
- **Models** (`models.ts`): the list comes from the Codex client's `~/.codex/models_cache.json` when it exists. Otherwise it falls back to a static list.

This extension signs in on its own. It never reads or refreshes the Codex app's `~/.codex/auth.json`, so it can't sign the Codex app out.

## Settings

Under `"codex-provider"` in `~/.agent-sh/settings.json`, all optional:

| Key | Default | Meaning |
|---|---|---|
| `providerId` | `"codex"` | Provider id used by `/model`, `defaultProvider` and `--provider` |
| `models` | from the Codex cache | Explicit model id list |
| `upstreamURL` | `https://chatgpt.com/backend-api/codex/responses` | Codex endpoint |
| `originator` | `"agent-sh"` | `originator` sent on sign-in and requests |

## Caveats

- The Codex backend is not a documented public API. It can change without notice, and this extension may need updates when it does.
- Usage counts against your ChatGPT plan's Codex limits. When you hit a limit, the error message says when it resets.

## Tests

```bash
node --import tsx --test examples/extensions/codex-provider/tests/*.test.ts
npx tsc -p examples/extensions/codex-provider
```
