import { getCapabilities, visibleWidth } from "@earendil-works/pi-tui";
import type { Renderer } from "../../renderer.js";
import { createNodes } from "./nodes.js";
import { createApp } from "./app.js";
import { mountCall, mountResult } from "./schema-mount.js";
import { createPiTuiToolGroup } from "./tool-group.js";
import { loadImageScale } from "../../display-config.js";

export function createPiTuiRenderer(): Renderer {
  const nodes = createNodes({ imageScale: loadImageScale() });
  return {
    ...nodes,
    capabilities: {
      images: getCapabilities().images !== null,
      markdownStreaming: true,
      rawOutput: true,
    },
    measureWidth: (text) => visibleWidth(text),
    mountToolCall: (model, args, env) => mountCall(model, args, env),
    mountToolResult: (model, args, env) => mountResult(model, args, env),
    mountToolGroup: () => createPiTuiToolGroup(),
    mount: () => createApp(),
  };
}
