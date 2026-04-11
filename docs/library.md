# Using agent-sh as a Library

The core can be imported directly for building custom frontends — no terminal required:

```typescript
import { createCore } from "agent-sh";

// Internal agent (any OpenAI-compatible API)
const core = createCore({
  agentCommand: "",
  agentArgs: [],
  apiKey: process.env.OPENAI_API_KEY,
  model: "gpt-4o",
});

// Subscribe to events
core.bus.on("agent:response-chunk", ({ blocks }) => {
  for (const b of blocks) if (b.type === "text") process.stdout.write(b.text);
});
core.bus.on("agent:processing-done", () => console.log("\n[done]"));

// Handle permissions (auto-approve, or wire to your own UI)
core.bus.onPipeAsync("permission:request", async (p) => {
  return { ...p, decision: { approved: true } };
});

// Send a query (no start() needed for internal agent)
core.bus.emit("agent:submit", { query: "explain this codebase" });

// Or use the convenience wrapper
const response = await core.query("explain this codebase");
```

For ACP agents, use `agentCommand` instead:

```typescript
const core = createCore({ agentCommand: "pi-acp", agentArgs: [] });
await core.start(); // ACP needs async startup (spawns subprocess)
const response = await core.query("hello");
```

This works for WebSocket servers, REST APIs, Electron apps, test harnesses, or any environment where you want agent-sh's context management and agent integration without the interactive terminal.

See [Architecture](architecture.md) for details on the core design and EventBus.
