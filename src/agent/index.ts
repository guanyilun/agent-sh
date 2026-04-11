/**
 * Agent backend exports.
 *
 * The default backend is AgentLoop (in-process, OpenAI-compatible API).
 * Extensions can register alternative backends via agent:register-backend.
 */

export type { AgentBackend } from "./types.js";
export type { ToolDefinition, ToolResult, ToolDisplayInfo } from "./types.js";
export { AgentLoop } from "./agent-loop.js";
export { ToolRegistry } from "./tool-registry.js";
