# agent-sh-acp

ACP (Agent Client Protocol) server that wraps agent-sh's headless core, allowing [agent-shell](https://github.com/xenodium/agent-shell) (Emacs) to use agent-sh as a backend.

## Setup

```bash
cd agent-sh-acp
npm install
npm run build    # or use `npx tsx src/index.ts` for dev
```

## Usage

### Emacs (agent-shell)

Add to your config:

```elisp
(require 'agent-shell-agentsh)

;; If not on PATH, set the command explicitly:
;; (setq agent-shell-agentsh-acp-command '("/path/to/agent-sh-acp"))

;; Launch it:
M-x agent-shell-agentsh-start-agent
```

### CLI flags

```bash
agent-sh-acp                          # use ~/.agent-sh/settings.json defaults
agent-sh-acp --model gpt-4o           # override model
agent-sh-acp --provider anthropic     # override provider
```

## How it works

```
agent-shell (Emacs)
    ↕ JSON-RPC over stdin/stdout (ACP)
agent-sh-acp
    ↕ EventBus
agent-sh core (headless)
    ↕ OpenAI-compatible API
LLM provider
```

The adapter translates between ACP methods and agent-sh's event bus:

- `initialize` → return capabilities
- `session/new` → create core, set cwd
- `session/prompt` → `agent:submit` event
- `session/update` notifications ← `agent:response-chunk`, `agent:tool-started`, etc.
- `session/request_permission` ↔ `permission:request` async pipe
