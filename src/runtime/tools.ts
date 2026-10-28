/** Opt-in local tools. Explicit environment/cwd; never activates a shell frontend. */
import type { HostExtension } from "./index.js";
import { attachAgentSurface } from "../agent/surface.js";
import { findBash } from "../utils/executor.js";
import { createBashTool } from "../agent/tools/bash.js";
import { createReadFileTool, type FileReadCache } from "../agent/tools/read-file.js";
import { createWriteFileTool } from "../agent/tools/write-file.js";
import { createEditFileTool } from "../agent/tools/edit-file.js";
import { createGrepTool } from "../agent/tools/grep.js";
import { createGlobTool } from "../agent/tools/glob.js";
import { createLsTool } from "../agent/tools/ls.js";

export function localTools(options: { names?: string[]; env?: Record<string, string> } = {}): HostExtension {
  return {
    name: "local-tools",
    activate(ctx) {
      const agent = attachAgentSurface(ctx);
      const getCwd = () => ctx.call("cwd") as string;
      // Snapshot rather than retaining a mutable environment supplied by caller.
      const env = { ...(options.env ?? Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))) };
      const cache = (ctx.call("agent:file-read-cache") as FileReadCache | undefined) ?? new Map();
      ctx.define("agent:file-read-cache", () => cache);
      const tools = [
        createReadFileTool(getCwd, cache), createWriteFileTool(getCwd),
        createEditFileTool(getCwd), createGrepTool(getCwd), createGlobTool(getCwd), createLsTool(getCwd),
      ];
      if (findBash() !== null) tools.push(createBashTool({ getCwd, getEnv: () => ({ ...env }), bus: ctx.bus }));
      const requested = new Set(options.names ?? tools.map(t => t.name));
      for (const name of requested) {
        if (!tools.some(tool => tool.name === name)) throw new Error(`Local tool unavailable: ${name}`);
      }
      for (const tool of tools) if (requested.has(tool.name)) agent.registerTool(tool);
    },
  };
}
