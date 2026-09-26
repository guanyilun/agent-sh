/**
 * Headless mode (`agent-sh -p`): run one prompt without the shell or TUI,
 * stream the reply to stdout, and exit. `--output json` prints one event
 * object per line instead, for scripts and tests.
 */
import * as fs from "node:fs";
import { activateAgent } from "../agent/index.js";
import { contentText } from "../agent/types.js";
import { createCore } from "../core/index.js";
import type { AppConfig } from "../core/index.js";
import { loadAllExtensions, requireBackends } from "./boot.js";

export type OutputFormat = "text" | "json";

export async function runHeadless(
  config: AppConfig,
  prompt: string,
  output: OutputFormat,
): Promise<never> {
  const query = [prompt, readPipedStdin()].filter(Boolean).join("\n\n").trim();
  if (!query) {
    console.error("agent-sh: -p needs a prompt (as an argument or on stdin).");
    process.exit(1);
  }

  const core = createCore(config);
  const { bus } = core;
  const json = output === "json";
  const emit = (event: Record<string, unknown>) => process.stdout.write(JSON.stringify(event) + "\n");
  let exitCode = 0;

  // Exit waits for piped stdout to drain; callers must not fall through meanwhile.
  const finish = (code: number): Promise<never> => {
    core.kill();
    process.stdout.write("", () => process.exit(code));
    return new Promise<never>(() => {});
  };

  bus.on("ui:error", ({ message }) => {
    if (json) emit({ type: "notice", level: "error", message });
    else process.stderr.write(`agent-sh: ${message}\n`);
  });
  bus.on("ui:info", ({ message }) => {
    if (json) emit({ type: "notice", level: "info", message });
  });
  bus.on("agent:error", ({ message }) => {
    exitCode = 1;
    if (json) emit({ type: "error", message });
    else process.stderr.write(`agent-sh: ${message}\n`);
  });
  bus.on("agent:response-chunk", ({ blocks }) => {
    for (const b of blocks) {
      if (b.type !== "text") continue;
      if (json) emit({ type: "text", text: b.text });
      else process.stdout.write(b.text);
    }
  });
  bus.on("agent:thinking-chunk", ({ text }) => {
    if (json) emit({ type: "thinking", text });
  });
  bus.on("agent:tool-started", (e) => {
    const name = e.name ?? e.title;
    if (json) emit({ type: "tool_start", id: e.toolCallId, name, args: e.rawInput, detail: e.displayDetail });
    else process.stderr.write(`→ ${name}${e.displayDetail ? ` ${e.displayDetail}` : ""}\n`);
  });
  bus.on("agent:tool-completed", (e) => {
    if (json) {
      const out = e.rawOutput as Parameters<typeof contentText>[0] | undefined;
      emit({ type: "tool_end", id: e.toolCallId, exitCode: e.exitCode, output: out === undefined ? undefined : contentText(out) });
    } else if (e.exitCode !== 0 && e.exitCode !== null) {
      process.stderr.write(`  ✗ exit ${e.exitCode}\n`);
    }
  });
  bus.on("agent:usage", (u) => {
    if (json) emit({ type: "usage", ...u });
  });

  const extCtx = core.extensionContext({ quit: () => { void finish(exitCode); } });
  activateAgent(extCtx);
  await loadAllExtensions(extCtx, config.extensions);
  requireBackends(core, config.backend);
  await core.activateBackend(config.backend);

  let interrupts = 0;
  process.on("SIGINT", () => {
    if (++interrupts > 1) process.exit(130);
    exitCode = 130;
    bus.emit("agent:cancel-request", { silent: false });
  });
  process.on("SIGTERM", () => { void finish(143); });

  const finished = new Promise<string>((resolve) => {
    let response = "";
    bus.on("agent:response-done", (e) => { response = e.response; });
    bus.on("agent:processing-done", () => resolve(response));
  });
  bus.emit("agent:submit", { query });
  const response = await finished;
  if (json) emit({ type: "done", exitCode, response });
  return finish(exitCode);
}

/** Only read stdin when something is piped or redirected in (a shell pipe
 *  is a FIFO, a spawned child's pipe is a socket), so a terminal or
 *  /dev/null never blocks. */
function readPipedStdin(): string {
  try {
    const stat = fs.fstatSync(0);
    if (!stat.isFIFO() && !stat.isFile() && !stat.isSocket()) return "";
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}
