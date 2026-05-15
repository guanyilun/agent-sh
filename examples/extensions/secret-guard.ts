/**
 * Secret guard extension.
 *
 * Redacts sensitive patterns (API keys, tokens, passwords) from tool output
 * — both the streamed terminal display and the content sent back to the LLM.
 *
 * Usage:
 *   agent-sh -e ./examples/extensions/secret-guard.ts
 *
 *   # Or install permanently:
 *   cp examples/extensions/secret-guard.ts ~/.agent-sh/extensions/
 *
 * Configuration (~/.agent-sh/settings.json):
 *   {
 *     "secret-guard": {
 *       "extraPatterns": ["CUSTOM_\\w+=\\S+"],
 *       "redactText": "***REDACTED***"
 *     }
 *   }
 */
import type { ExtensionContext } from "agent-sh/types";

// Common secret patterns — each matches key=value or key: value formats
const DEFAULT_PATTERNS = [
  // API keys and tokens (generic)
  /(?:api[_-]?key|api[_-]?secret|access[_-]?token|auth[_-]?token|secret[_-]?key|private[_-]?key)\s*[=:]\s*\S+/gi,
  // AWS
  /(?:AKIA|ASIA)[A-Z0-9]{16}/g,
  /(?:aws_secret_access_key|aws_session_token)\s*[=:]\s*\S+/gi,
  // Bearer tokens
  /Bearer\s+[A-Za-z0-9\-._~+/]+=*/g,
  // GitHub tokens
  /gh[pousr]_[A-Za-z0-9_]{36,}/g,
  // Anthropic / OpenAI keys
  /sk-(?:ant-)?[A-Za-z0-9\-_]{10,}/g,
  // Generic long hex/base64 secrets (env var assignment)
  /(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY)\s*[=:]\s*\S+/gi,
  // Connection strings with passwords
  /[a-z+]+:\/\/[^:]+:[^@\s]+@/gi,
];

export default function activate(ctx: ExtensionContext) {
  const { bus } = ctx;
  const config = ctx.getExtensionSettings("secret-guard", {
    extraPatterns: [] as string[],
    redactText: "***REDACTED***",
  });

  const patterns = [
    ...DEFAULT_PATTERNS,
    ...config.extraPatterns.map((p: string) => new RegExp(p, "gi")),
  ];

  function redact(text: string): string {
    let result = text;
    for (const pattern of patterns) {
      // Reset lastIndex for stateful regex (global flag)
      pattern.lastIndex = 0;
      result = result.replace(pattern, config.redactText);
    }
    return result;
  }

  // Redact the dynamic context (shell history, cwd, etc.) before it's sent
  // to the LLM. This is the chokepoint — everything the model sees passes
  // through dynamic-context:build.
  ctx.advise("dynamic-context:build", (next) => {
    return redact(next());
  });

  // Advise tool:execute to wrap both streaming output and final result.
  // Chunks from child processes arrive at arbitrary byte boundaries, so a
  // secret like "sk-ant-abc123" could be split across two chunks.  We
  // line-buffer: accumulate until we see '\n', redact complete lines, flush.
  ctx.advise("tool:execute", async (next, toolCtx) => {
    const origOnChunk = toolCtx.onChunk;
    if (origOnChunk) {
      let buf = "";
      toolCtx.onChunk = (chunk: string) => {
        buf += chunk;
        const lastNl = buf.lastIndexOf("\n");
        if (lastNl !== -1) {
          // Flush all complete lines, redacted
          origOnChunk(redact(buf.slice(0, lastNl + 1)));
          buf = buf.slice(lastNl + 1);
        }
      };

      const result = await next(toolCtx);

      // Flush any remaining partial line
      if (buf) origOnChunk(redact(buf));

      return { ...result, content: redact(result.content) };
    }

    const result = await next(toolCtx);
    return { ...result, content: redact(result.content) };
  });
}
