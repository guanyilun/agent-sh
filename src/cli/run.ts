/** `agent-sh run <file>`: run a workflow file directly, with the setup it declares in `export const config`. */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { activateAgent } from "../agent/index.js";
import { createCore, type RunConfig } from "../core/index.js";
import { importUserModule } from "../core/import-module.js";
import type { CliConfig } from "./args.js";
import { loadAllExtensions, requireBackends } from "./boot.js";

export interface RunArgs {
  file: string;
  /** The workflow's own arguments, as given. */
  tokens: string[];
  /** agent-sh options (--model, -e, ...), for the usual CLI parser. */
  cli: string[];
  resume?: string;
  dryRun: boolean;
  help: boolean;
}

const WRAPPED = "AGENT_SH_RUN_WRAPPED";
const CLI_VALUE_FLAGS = new Set(["--model", "--provider", "--api-key", "--base-url", "--backend", "--shell", "-e", "--extensions"]);

/** Splits `run` arguments: the file, agent-sh's options, and the rest (or everything after `--`) for the workflow. */
export function parseRunArgs(argv: string[]): RunArgs | null {
  const r: Omit<RunArgs, "file"> & { file?: string } = { tokens: [], cli: [], dryRun: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") { r.tokens.push(...argv.slice(i + 1)); break; }
    if (a === "--resume") r.resume = argv[++i];
    else if (a === "--dry-run") r.dryRun = true;
    else if (a === "--help" || a === "-h") r.help = true;
    else if (CLI_VALUE_FLAGS.has(a)) r.cli.push(a, argv[++i] ?? "");
    else if (!r.file) r.file = a;
    else r.tokens.push(a);
  }
  return r.file ? { ...r, file: r.file } : null;
}

export async function runFile(cli: CliConfig, run: RunArgs): Promise<never> {
  const exit = (code: number, message?: string): never => {
    if (message) process.stderr.write(`agent-sh run: ${message}\n`);
    process.exit(code);
  };

  const file = path.resolve(run.file);
  if (!fs.existsSync(file)) exit(1, `no such file: ${run.file}`);
  const mod = await importUserModule(file).catch((err) => exit(1, `could not load ${run.file}: ${err instanceof Error ? err.message : err}`));
  if (typeof (mod.default ?? mod.run) !== "function") exit(1, `${run.file} must export a default function`);
  const config: RunConfig = { ...(mod.config as Record<string, unknown> | undefined), base: path.dirname(file) };

  const core = createCore({
    ...cli,
    model: cli.model ?? (config.model as string | undefined),
    provider: cli.provider ?? (config.provider as string | undefined),
  });
  const { bus } = core;
  bus.on("ui:error", ({ message }) => process.stderr.write(`agent-sh: ${message}\n`));
  bus.on("ui:info", ({ message }) => process.stderr.write(`agent-sh: ${message}\n`));

  // Defined before extensions load, so each can read its section while activating.
  core.handlers.define("run:config", () => config);
  const extCtx = core.extensionContext({ quit: () => process.exit(0) });
  activateAgent(extCtx);
  await loadAllExtensions(extCtx, cli.extensions);
  const has = (name: string) => core.handlers.list().includes(name);

  if (run.help) {
    const text = has("workflow:help") ? core.handlers.call("workflow:help", { file, module: mod }) as string
      : `Usage: agent-sh run ${run.file} [args...]`;
    process.stdout.write(`${text}\n\nagent-sh run options: --dry-run (no model calls), --resume <run id>, --model, --provider, -e <extension>\n`, () => exit(0));
    return new Promise<never>(() => {});
  }
  if (!run.dryRun) requireBackends(core, cli.backend);

  if (!process.env[WRAPPED] && !run.dryRun) {
    const argv = [process.execPath, ...process.execArgv, ...process.argv.slice(1)];
    const wrapped = bus.emitPipe("run:wrap", { argv, config }).argv;
    if (wrapped !== argv) {
      const child = spawn(wrapped[0]!, wrapped.slice(1), { stdio: "inherit", env: { ...process.env, [WRAPPED]: "1" } });
      process.on("SIGINT", () => child.kill("SIGINT"));
      process.on("SIGTERM", () => child.kill("SIGTERM"));
      child.on("error", (err) => exit(2, `could not start the wrapped run: ${err.message}`));
      child.on("exit", (code, signal) => exit(code ?? (signal === "SIGINT" ? 130 : 1)));
      return new Promise<never>(() => {});
    }
  }

  const { problems, handled } = bus.emitPipe("run:checks", { config, problems: [], handled: [] });
  if (config.sandbox && !handled.includes("sandbox")) {
    problems.push("config.sandbox is set but no loaded extension enforces it (load the sandbox extension).");
  }
  if (problems.length && run.dryRun) process.stderr.write(`agent-sh run: (dry run) a real run would refuse to start:\n  - ${problems.join("\n  - ")}\n`);
  else if (problems.length) exit(2, `refusing to start:\n  - ${problems.join("\n  - ")}`);
  if (!has("workflow:run-file")) exit(2, "running a workflow file needs the subagents extension.");

  const controller = new AbortController();
  let interrupts = 0;
  process.on("SIGINT", () => {
    if (++interrupts > 1) exit(130);
    controller.abort(new Error("interrupted"));
  });
  const hours = Number(config.hours);
  if (hours > 0) setTimeout(() => controller.abort(new Error(`deadline of ${hours} h reached`)), hours * 3600_000).unref();

  const result = await (core.handlers.call("workflow:run-file", {
    file, module: mod, args: run.tokens.join(" "), tokens: run.tokens, resume: run.resume, dryRun: run.dryRun, config,
    signal: controller.signal,
    progress: (line: string) => process.stderr.write(`${line}\n`),
  }) as Promise<{ content: string; isError: boolean; refused?: boolean }>);
  if (result.refused) exit(2, result.content);
  if (controller.signal.aborted && interrupts) exit(130, "interrupted");
  const reason = controller.signal.aborted ? (controller.signal.reason as Error).message : undefined;
  process.stdout.write(`${result.content}\n`, () => exit(result.isError || reason ? 1 : 0, reason));
  return new Promise<never>(() => {});
}
