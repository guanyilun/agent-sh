/**
 * Echo backend — minimal extension-as-agent-backend example.
 *
 * Registers itself as the agent backend and echoes queries back.
 * Use to test that the extension backend mechanism works.
 *
 * Usage: agent-sh -e examples/extensions/echo-backend.ts
 */
import type { ExtensionContext } from "../../src/types.js";

export default function activate({ bus }: ExtensionContext): void {
  bus.emit("agent:register-backend", {
    name: "echo",
    kill: () => {},
  });

  bus.on("agent:submit", ({ query }) => {
    bus.emit("agent:processing-start", {});
    bus.emit("agent:query", { query });

    bus.emitTransform("agent:response-chunk", {
      blocks: [{ type: "text", text: `Echo: ${query}\n` }],
    });

    bus.emitTransform("agent:response-done", {
      response: `Echo: ${query}`,
    });

    bus.emit("agent:processing-done", {});
  });

  bus.emit("agent:info", { name: "echo-backend", version: "1.0.0" });
}
