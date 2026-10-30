import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import type { AgentToolDispatcher } from "../agent/run-contract.js";
import type { ToolDefinition, ToolResult } from "../agent/types.js";

interface TransportOptions {
  /** Maximum UTF-8 bytes per JSONL message, excluding newline (default 1 MiB). */
  maxMessageBytes?: number;
  /** Maximum queued output bytes; slow consumers fail closed (default 4 messages). */
  maxQueuedBytes?: number;
}

export interface ProcessToolExecutorOptions extends TransportOptions {
  command: string;
  args?: string[];
  cwd?: string;
  /** Passed directly to spawn; omitted means inherit the controller environment. */
  env?: NodeJS.ProcessEnv;
  /** Cancels the executor's lifetime, independently of individual call signals. */
  signal?: AbortSignal;
  /** Grace period for each of SIGTERM and SIGKILL (default 1000 ms). */
  shutdownTimeoutMs?: number;
}

export interface ServeToolExecutorOptions extends TransportOptions {
  tools: ToolDefinition[];
  input?: Readable;
  output?: Writable;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`);
  return value;
}

function limits(options: TransportOptions) {
  const message = positiveInteger(options.maxMessageBytes ?? 1024 * 1024, "maxMessageBytes");
  const queued = positiveInteger(options.maxQueuedBytes ?? message * 4, "maxQueuedBytes");
  return { message, queued };
}

function errorOf(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function abortError(): Error {
  const error = new Error("Process tool execution cancelled");
  error.name = "AbortError";
  return error;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** No application queue: use the stream's bounded buffer, failing on overload. */
function send(output: Writable, value: unknown, bounds: ReturnType<typeof limits>): void {
  const json = JSON.stringify(value);
  const bytes = Buffer.byteLength(json);
  if (bytes > bounds.message) throw new Error("Process tool message exceeds maxMessageBytes");
  if (output.destroyed || output.writableEnded) throw new Error("Process tool output is closed");
  if (output.writableLength + bytes + 1 > bounds.queued) {
    throw new Error("Process tool output backpressure exceeds maxQueuedBytes");
  }
  output.write(json + "\n");
}

/** Frame bytes before decoding, so split UTF-8 and unterminated lines stay bounded. */
function receive(
  input: Readable,
  maxBytes: number,
  onMessage: (message: Record<string, unknown>) => void,
  onError: (error: Error) => void,
  onEnd: () => void,
): () => void {
  let buffered = Buffer.alloc(0);
  let stopped = false;
  const stop = () => {
    stopped = true;
    input.off("data", data);
    input.off("error", fail);
    input.off("end", end);
    input.off("close", end);
    buffered = Buffer.alloc(0);
  };
  const fail = (error: Error) => {
    if (stopped) return;
    stop();
    onError(error);
  };
  const data = (chunk: Buffer | string) => {
    try {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      let start = 0;
      while (start < bytes.length && !stopped) {
        const newline = bytes.indexOf(10, start);
        const end = newline < 0 ? bytes.length : newline;
        const part = bytes.subarray(start, end);
        if (buffered.length + part.length > maxBytes) throw new Error("Process tool message exceeds maxMessageBytes");
        buffered = Buffer.concat([buffered, part]);
        if (newline < 0) break;
        const parsed: unknown = JSON.parse(buffered.toString("utf8"));
        buffered = Buffer.alloc(0);
        if (!object(parsed)) throw new Error("Invalid process tool message");
        onMessage(parsed);
        start = newline + 1;
      }
    } catch (error) {
      fail(errorOf(error));
    }
  };
  const end = () => {
    if (stopped) return;
    if (buffered.length) return fail(new Error("Truncated process tool message"));
    stop();
    onEnd();
  };
  input.on("data", data);
  input.on("error", fail);
  input.on("end", end);
  input.on("close", end);
  return stop;
}

function isResult(value: unknown): value is ToolResult {
  return object(value)
    && (typeof value.content === "string" || (Array.isArray(value.content) && value.content.every(image =>
      object(image) && image.type === "image" && typeof image.data === "string" && typeof image.mimeType === "string")))
    && (value.exitCode === null || (typeof value.exitCode === "number" && Number.isFinite(value.exitCode)))
    && typeof value.isError === "boolean";
}

/**
 * Execute tools in a caller-selected process over stdin/stdout JSONL. Install
 * `dispatch` as the injectable `tool:dispatch` handler, inside existing policy.
 * Only {id,type,name,args} crosses the boundary, never tool code or schemas.
 * Per-call context.signal is forwarded as cancellation, not replaced by a run's
 * or parent's signal. Interactive UI capabilities are intentionally not sent.
 *
 * SECURITY: the trusted controller must select the executable/argv OS sandbox
 * wrapper and appropriate cwd/env. A separate process alone is NOT filesystem,
 * network, credential, or OS isolation. Environment inherits unless supplied.
 * The worker owns its tool allowlist. stdout is exclusively protocol; stderr is
 * inherited for diagnostics. Cancellation is cooperative until disposal kills
 * the direct child; process-tree containment is the sandbox wrapper's job.
 */
export function createProcessToolExecutor(options: ProcessToolExecutorOptions): {
  dispatch: AgentToolDispatcher;
  dispose(): Promise<void>;
} {
  const bounds = limits(options);
  const timeout = positiveInteger(options.shutdownTimeoutMs ?? 1000, "shutdownTimeoutMs");
  const child = spawn(options.command, options.args ?? [], {
    cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "inherit"], shell: false,
  });
  type Pending = {
    resolve: (result: ToolResult) => void;
    reject: (error: unknown) => void;
    onChunk?: (chunk: string) => void;
    cleanup: () => void;
  };
  const pending = new Map<string, Pending>();
  let sequence = 0;
  let terminal: Error | undefined;
  let disposal: Promise<void> | undefined;
  let exited = false;
  let markExited!: () => void;
  const exit = new Promise<void>(resolve => { markExited = resolve; });
  const settle = (id: string) => {
    const call = pending.get(id);
    if (call) {
      pending.delete(id);
      call.cleanup();
    }
    return call;
  };
  const fail = (error: Error) => {
    terminal ??= error;
    for (const id of pending.keys()) settle(id)!.reject(terminal);
  };
  const broken = (error: Error) => {
    fail(error);
    void dispose().catch(() => {});
  };
  const stopReceiving = receive(child.stdout, bounds.message, message => {
    if (typeof message.id !== "string") throw new Error("Invalid process tool response id");
    if (message.type === "chunk" && typeof message.chunk === "string") {
      const call = pending.get(message.id);
      try { call?.onChunk?.(message.chunk); }
      catch (error) {
        settle(message.id)?.reject(error);
        send(child.stdin, { id: message.id, type: "cancel" }, bounds);
      }
    } else if (message.type === "result" && isResult(message.result)) {
      settle(message.id)?.resolve(message.result);
    } else if (message.type === "error" && typeof message.error === "string") {
      settle(message.id)?.reject(new Error(message.error));
    } else {
      throw new Error("Invalid process tool response");
    }
  }, broken, () => broken(new Error("Process tool stdout closed")));
  child.stdin.on("error", broken);
  child.on("error", error => {
    // A spawn failure has no exit event. Errors from kill(), however, do not
    // prove the child exited; shutdown must still enforce its bounded wait.
    if (child.pid === undefined) {
      exited = true;
      markExited();
    }
    broken(error);
  });
  child.on("exit", (code, signal) => {
    exited = true;
    markExited();
    broken(new Error(`Process tool exited (code ${code}, signal ${signal})`));
  });

  const dispatch: AgentToolDispatcher = async ({ name, args, onChunk, context }) => {
    if (terminal) throw terminal;
    const signal = context.signal;
    if (signal?.aborted) throw signal.reason ?? abortError();
    const id = String(++sequence);
    return new Promise<ToolResult>((resolve, reject) => {
      const cancel = () => {
        settle(id)?.reject(signal?.reason ?? abortError());
        try { send(child.stdin, { id, type: "cancel" }, bounds); }
        catch (error) { broken(errorOf(error)); }
      };
      pending.set(id, { resolve, reject, onChunk, cleanup: () => signal?.removeEventListener("abort", cancel) });
      signal?.addEventListener("abort", cancel, { once: true });
      try { send(child.stdin, { id, type: "execute", name, args }, bounds); }
      catch (error) { settle(id)?.reject(error); }
    });
  };

  async function waitForExit(): Promise<boolean> {
    if (exited) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([exit, new Promise<void>(resolve => { timer = setTimeout(resolve, timeout); })]);
    clearTimeout(timer);
    return exited;
  }

  function dispose(): Promise<void> {
    if (disposal) return disposal;
    // Set terminal synchronously: no new dispatch can race shutdown.
    for (const id of pending.keys()) {
      try { send(child.stdin, { id, type: "cancel" }, bounds); } catch { break; }
    }
    fail(new Error("Process tool executor disposed"));
    options.signal?.removeEventListener("abort", lifetimeAbort);
    disposal = Promise.resolve().then(async () => {
      try {
        if (!exited) child.kill("SIGTERM");
        if (!await waitForExit()) {
          child.kill("SIGKILL");
          if (!await waitForExit()) throw new Error("Process tool did not exit after SIGKILL");
        }
      } finally {
        stopReceiving();
        child.stdin.destroy();
        child.stdout.destroy();
        child.unref();
      }
    });
    return disposal;
  }
  function lifetimeAbort() {
    fail(errorOf(options.signal?.reason ?? abortError()));
    void dispose().catch(() => {});
  }
  options.signal?.addEventListener("abort", lifetimeAbort, { once: true });
  if (options.signal?.aborted) lifetimeAbort();
  return { dispatch, dispose };
}

/**
 * Serve a fixed, worker-owned tool allowlist. Uses process stdin/stdout by
 * default; never log to stdout. Requests are {id,type:'execute',name,args} or
 * {id,type:'cancel'}. Replies are {id,type:'chunk',chunk:string},
 * {id,type:'result',result:ToolResult}, or {id,type:'error',error:string}.
 * IDs are strings, unique among active requests. Errors reject dispatch; tool
 * results with isError:true remain results. Each call gets an AbortController.
 * Unknown names reject without executing anything. Cancellation is cooperative:
 * tools must honor context.signal; the controller can terminate the worker.
 * EOF aborts active calls; this function does not end caller-owned streams.
 * Message/queued-output limits apply in both directions, failing closed rather
 * than buffering unlimited output from synchronous onChunk callbacks.
 * This is a protocol boundary, not an OS sandbox (see createProcessToolExecutor).
 */
export function serveToolExecutor(options: ServeToolExecutorOptions): Promise<void> {
  const bounds = limits(options);
  const tools = new Map<string, ToolDefinition>();
  for (const tool of options.tools) {
    if (tools.has(tool.name)) throw new Error(`Duplicate process tool: ${tool.name}`);
    tools.set(tool.name, tool);
  }
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const active = new Map<string, AbortController>();
  return new Promise<void>((resolve, reject) => {
    let closed = false;
    let stopReceiving = () => {};
    const finish = (error?: Error) => {
      if (closed) return;
      closed = true;
      stopReceiving();
      output.off("error", finish);
      output.off("close", outputClosed);
      for (const controller of active.values()) controller.abort(error ?? abortError());
      active.clear();
      if (error) reject(error); else resolve();
    };
    const outputClosed = () => finish(new Error("Process tool output closed"));
    const emit = (message: unknown) => {
      if (closed) return;
      try { send(output, message, bounds); }
      catch (error) { finish(errorOf(error)); }
    };
    output.on("error", finish);
    output.on("close", outputClosed);
    stopReceiving = receive(input, bounds.message, message => {
      const { id, type } = message;
      if (typeof id !== "string" || !id) throw new Error("Invalid process tool request id");
      if (type === "cancel") {
        active.get(id)?.abort(abortError());
        return;
      }
      if (type !== "execute" || typeof message.name !== "string" || !object(message.args)) {
        throw new Error("Invalid process tool request");
      }
      if (active.has(id)) throw new Error(`Duplicate process tool request id: ${id}`);
      const tool = tools.get(message.name);
      if (!tool) {
        emit({ id, type: "error", error: `Unknown process tool: ${message.name}` });
        return;
      }
      const controller = new AbortController();
      active.set(id, controller);
      const args = message.args;
      void (async () => {
        try {
          const result = await tool.execute(args, chunk => {
            if (!controller.signal.aborted) emit({ id, type: "chunk", chunk });
          }, { signal: controller.signal });
          if (!isResult(result)) throw new Error("Invalid process tool result");
          emit({ id, type: "result", result });
        } catch (error) {
          emit({ id, type: "error", error: errorOf(error).message });
        } finally {
          active.delete(id);
        }
      })();
    }, finish, () => finish());
  });
}
