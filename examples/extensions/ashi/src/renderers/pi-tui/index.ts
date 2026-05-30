import { visibleWidth } from "@earendil-works/pi-tui";
import type { Renderer } from "../../renderer.js";
import { createNodes } from "./nodes.js";
import { createApp } from "./app.js";
import { mountCall, mountResult } from "./schema-mount.js";

export function createPiTuiRenderer(): Renderer {
  const nodes = createNodes();
  return {
    ...nodes,
    capabilities: {
      images: true,
      markdownStreaming: true,
    },
    measureWidth: (text) => visibleWidth(text),
    mountToolCall: (model, args, env) => mountCall(model, args, env),
    mountToolResult: (model, args, env) => mountResult(model, args, env),
    mount: () => createApp(),
  };
}
