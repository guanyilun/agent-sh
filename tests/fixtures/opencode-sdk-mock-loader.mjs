const STUB_URL = new URL("./opencode-sdk-stub.mjs", import.meta.url).href;
const REPO_ROOT = new URL("../../", import.meta.url);

// agent-sh/utils/* → dist/utils/* (no node_modules/agent-sh in-process).
const AGENT_SH_MAP = {
  "agent-sh/utils/diff": "dist/utils/diff.js",
  "agent-sh/utils/tool-interactive": "dist/utils/tool-interactive.js",
  "agent-sh/utils/palette": "dist/utils/palette.js",
};

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@opencode-ai/sdk/v2") {
    return { url: STUB_URL, format: "module", shortCircuit: true };
  }
  const mapped = AGENT_SH_MAP[specifier];
  if (mapped) {
    return { url: new URL(mapped, REPO_ROOT).href, format: "module", shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
