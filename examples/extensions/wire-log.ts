/**
 * Wire log — captures every LLM request + stream chunk to disk for
 * debugging protocol issues (tool-call collapse, streaming bugs,
 * provider response shape questions).
 *
 * Enable by renaming to wire-log.ts (or adding to settings.json
 * extensions list). Outputs to $AGENT_SH_WIRE_DIR or ~/.agent-sh/wire
 * by default. One directory per session, one pair of files per turn:
 *
 *   2026-04-24T13-33-57-213Z.request.json   — messages, tools, model
 *   2026-04-24T13-33-57-213Z.chunks.jsonl   — one streaming chunk per line
 *
 * Replay a captured request via curl:
 *   jq 'del(.stream, .stream_options)' <file>.request.json |
 *     curl -sS $OPENAI_BASE_URL/chat/completions \
 *       -H "Authorization: Bearer $OPENAI_API_KEY" \
 *       -H "Content-Type: application/json" -d @-
 *
 * Disk cost: ~tens of KB per turn. Strip with `rm -rf ~/.agent-sh/wire`
 * when done.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { ExtensionContext } from "agent-sh/types";

export default function activate(ctx: ExtensionContext): void {
  const dir = process.env.AGENT_SH_WIRE_DIR
    ?? path.join(os.homedir(), ".agent-sh", "wire");
  fs.mkdirSync(dir, { recursive: true });

  // Pair request with its chunks via a shared timestamp. The llm:chunk
  // listener has no direct link back to the request that triggered it,
  // so we anchor on the most recent llm:request stamp.
  let currentStamp: string | null = null;

  ctx.bus.on("llm:request", (req) => {
    currentStamp = new Date().toISOString().replace(/[:.]/g, "-");
    fs.writeFileSync(
      path.join(dir, `${currentStamp}.request.json`),
      JSON.stringify(req, null, 2),
    );
  });

  ctx.bus.on("llm:chunk", ({ chunk }) => {
    if (!currentStamp) return;
    fs.appendFileSync(
      path.join(dir, `${currentStamp}.chunks.jsonl`),
      JSON.stringify(chunk) + "\n",
    );
  });
}
