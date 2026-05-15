/**
 * Dumps every LLM request + streamed chunk to $AGENT_SH_WIRE_DIR
 * (default ~/.agent-sh/wire) for offline replay via curl. Paired files
 * per turn: <stamp>.request.json and <stamp>.chunks.jsonl.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { ExtensionContext } from "agent-sh/types";

export default function activate(ctx: ExtensionContext): void {
  const dir = process.env.AGENT_SH_WIRE_DIR
    ?? path.join(os.homedir(), ".agent-sh", "wire");
  fs.mkdirSync(dir, { recursive: true });

  // llm:chunk has no back-pointer to its request, so anchor both on
  // the timestamp set when llm:request fires.
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
