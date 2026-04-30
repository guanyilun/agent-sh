import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { stripAnsi } from "./utils/ansi.js";

let cachedBashPath: string | null | undefined;

/** Resolve a usable bash binary, or null if none is on PATH.
 *  Unix: `/bin/bash` (canonical, present on every Linux/macOS install).
 *  Windows: probe via `where bash` so Git Bash users keep working. */
export function findBash(): string | null {
  if (cachedBashPath !== undefined) return cachedBashPath;
  if (process.platform !== "win32") {
    cachedBashPath = "/bin/bash";
    return cachedBashPath;
  }
  const r = spawnSync("where", ["bash"], { encoding: "utf-8" });
  cachedBashPath = r.status === 0 ? r.stdout.split(/\r?\n/)[0]!.trim() || null : null;
  return cachedBashPath;
}

const DEFAULT_TIMEOUT = 60_000;
const DEFAULT_MAX_OUTPUT = 256 * 1024; // 256KB

export interface ExecutorSession {
  id: string;
  command: string;
  output: string;          // accumulated, ANSI-stripped
  exitCode: number | null;
  done: boolean;
  truncated: boolean;
  /** True when the binary couldn't be launched (ENOENT, EACCES). Lets callers
   *  distinguish "tool missing" from "tool ran and exited with -1". */
  spawnFailed: boolean;
  process: ChildProcess | null;
  resolve?: () => void;
}


/**
 * Spawn a command in an isolated child process with piped I/O.
 * Does NOT use the user's PTY — completely separate process.
 */
export function executeCommand(opts: {
  command: string;
  cwd: string;
  env?: Record<string, string>;
  timeout?: number;
  maxOutputBytes?: number;
  onOutput?: (chunk: string) => void;
}): { session: ExecutorSession; done: Promise<void> } {
  const timeout = opts.timeout ?? DEFAULT_TIMEOUT;
  const maxOutput = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;

  const session: ExecutorSession = {
    id: "",
    command: opts.command,
    output: "",
    exitCode: null,
    done: false,
    truncated: false,
    spawnFailed: false,
    process: null,
  };

  const done = new Promise<void>((resolve) => {
    session.resolve = resolve;
  });

  // Build env — filter undefined values
  const env: Record<string, string> = {};
  const source = opts.env ?? process.env;
  for (const [k, v] of Object.entries(source)) {
    if (v !== undefined) env[k] = v;
  }

  const bashPath = findBash();
  let child: ChildProcess;
  try {
    if (!bashPath) throw new Error("bash not found on PATH");
    child = spawn(bashPath, ["-c", opts.command], {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: opts.cwd,
      env,
      detached: true,
    });
  } catch (err) {
    session.exitCode = -1;
    session.spawnFailed = true;
    session.output = `Failed to spawn: ${err instanceof Error ? err.message : String(err)}`;
    session.done = true;
    session.resolve?.();
    return { session, done };
  }

  session.process = child;

  const handleData = (data: Buffer) => {
    const raw = data.toString("utf-8");
    const clean = stripAnsi(raw);

    // Accumulate cleaned output for the agent
    session.output += clean;

    // Enforce output cap — truncate from beginning, keep tail
    if (session.output.length > maxOutput) {
      session.output = session.output.slice(-maxOutput);
      session.truncated = true;
    }

    // Real-time streaming callback
    opts.onOutput?.(raw);
  };

  child.stdout?.on("data", handleData);
  child.stderr?.on("data", handleData);

  let cancelKill: (() => void) | undefined;
  const timer = setTimeout(() => {
    if (!session.done) {
      cancelKill = killSession(session);
    }
  }, timeout);

  child.on("exit", (code, signal) => {
    clearTimeout(timer);
    cancelKill?.();
    session.exitCode = code ?? (signal ? -1 : null);
    session.done = true;
    session.process = null;
    session.resolve?.();
  });

  child.on("error", (err) => {
    clearTimeout(timer);
    cancelKill?.();
    if (!session.done) {
      session.exitCode = -1;
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "EACCES") session.spawnFailed = true;
      session.output += `\nProcess error: ${err.message}`;
      session.done = true;
      session.process = null;
      session.resolve?.();
    }
  });

  return { session, done };
}

/**
 * Spawn a binary directly (no shell). Use for invoking known tools like `rg`
 * with structured args — avoids shell-quoting bugs and works on platforms
 * without /bin/bash.
 */
export function executeArgv(opts: {
  file: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  timeout?: number;
  maxOutputBytes?: number;
  onOutput?: (chunk: string) => void;
}): { session: ExecutorSession; done: Promise<void> } {
  const timeout = opts.timeout ?? DEFAULT_TIMEOUT;
  const maxOutput = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;

  const session: ExecutorSession = {
    id: "",
    command: `${opts.file} ${opts.args.join(" ")}`,
    output: "",
    exitCode: null,
    done: false,
    truncated: false,
    spawnFailed: false,
    process: null,
  };

  const done = new Promise<void>((resolve) => {
    session.resolve = resolve;
  });

  const env: Record<string, string> = {};
  const source = opts.env ?? process.env;
  for (const [k, v] of Object.entries(source)) {
    if (v !== undefined) env[k] = v;
  }

  let child: ChildProcess;
  try {
    child = spawn(opts.file, opts.args, {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: opts.cwd,
      env,
    });
  } catch (err) {
    session.exitCode = -1;
    session.spawnFailed = true;
    session.output = `Failed to spawn ${opts.file}: ${err instanceof Error ? err.message : String(err)}`;
    session.done = true;
    session.resolve?.();
    return { session, done };
  }

  session.process = child;

  const handleData = (data: Buffer) => {
    const raw = data.toString("utf-8");
    const clean = stripAnsi(raw);
    session.output += clean;
    if (session.output.length > maxOutput) {
      session.output = session.output.slice(-maxOutput);
      session.truncated = true;
    }
    opts.onOutput?.(raw);
  };

  child.stdout?.on("data", handleData);
  child.stderr?.on("data", handleData);

  const timer = setTimeout(() => {
    if (!session.done && session.process) {
      try { session.process.kill("SIGTERM"); } catch {}
      setTimeout(() => {
        if (!session.done && session.process) {
          try { session.process.kill("SIGKILL"); } catch {}
        }
      }, 5000).unref();
    }
  }, timeout);

  child.on("exit", (code, signal) => {
    clearTimeout(timer);
    session.exitCode = code ?? (signal ? -1 : null);
    session.done = true;
    session.process = null;
    session.resolve?.();
  });

  child.on("error", (err) => {
    clearTimeout(timer);
    if (!session.done) {
      session.exitCode = -1;
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "EACCES") session.spawnFailed = true;
      session.output += `\nProcess error: ${err.message}`;
      session.done = true;
      session.process = null;
      session.resolve?.();
    }
  });

  return { session, done };
}

/**
 * Kill a running session's process group: SIGTERM, then SIGKILL after 5s.
 * Returns a cleanup that cancels the pending SIGKILL — callers should invoke
 * it once the process has exited.
 */
export function killSession(session: ExecutorSession): () => void {
  const proc = session.process;
  if (!proc || !proc.pid) return () => {};

  // Try process-group kill first (works for executeCommand's detached bash
  // children); fall back to direct kill (executeArgv's non-detached spawn,
  // and Windows where negative pids aren't supported).
  try { process.kill(-proc.pid, "SIGTERM"); } catch {}
  try { proc.kill("SIGTERM"); } catch {}

  let settled = false;
  const fallback = setTimeout(() => {
    if (!settled && !session.done && proc.pid) {
      try { process.kill(-proc.pid, "SIGKILL"); } catch {}
      try { proc.kill("SIGKILL"); } catch {}
    }
  }, 5000);

  fallback.unref();

  return () => {
    if (!settled) {
      settled = true;
      clearTimeout(fallback);
    }
  };
}
