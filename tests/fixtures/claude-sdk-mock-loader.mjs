const STUB_URL = new URL("./claude-sdk-stub.mjs", import.meta.url).href;
const REPO_ROOT = new URL("../../", import.meta.url);

// agent-sh/utils/* → dist/utils/* (no node_modules/agent-sh in-process).
const AGENT_SH_MAP = {
  "agent-sh/utils/diff": "dist/utils/diff.js",
};

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@anthropic-ai/claude-agent-sdk") {
    return { url: STUB_URL, format: "module", shortCircuit: true };
  }
  const mapped = AGENT_SH_MAP[specifier];
  if (mapped) {
    return { url: new URL(mapped, REPO_ROOT).href, format: "module", shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
