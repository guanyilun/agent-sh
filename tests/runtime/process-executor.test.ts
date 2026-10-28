import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import { createCore } from "../../src/core/index.js";
import type { ToolDefinition } from "../../src/agent/types.js";
import {
  createProcessToolExecutor, serveToolExecutor,
  type ProcessToolExecutorOptions,
} from "../../src/runtime/process-executor.js";

const moduleURL = new URL("../../src/runtime/process-executor.ts", import.meta.url).href;
const fixture = `
  import { serveToolExecutor } from ${JSON.stringify(moduleURL)};
  let cancellations = 0;
  const ok = content => ({ content, exitCode: 0, isError: false });
  const tool = (name, execute) => ({ name, execute, description: name, input_schema: {} });
  await serveToolExecutor({ tools: [
    tool('echo', async (args, chunk) => {
      chunk('start:' + args.value);
      await new Promise(resolve => setTimeout(resolve, args.delay ?? 0));
      chunk('end:' + args.value);
      return ok(JSON.stringify(args));
    }),
    tool('wait', async (_args, chunk, context) => {
      return new Promise((resolve, reject) => {
        context.signal.addEventListener('abort', () => {
          cancellations++;
          reject(context.signal.reason);
        }, { once: true });
        chunk('ready');
      });
    }),
    tool('cancellations', async () => ok(String(cancellations))),
    tool('fail', async () => { throw new Error('worker failure'); }),
    tool('exit', async () => { process.exit(23); }),
    tool('environment', async () => ok(JSON.stringify({ cwd: process.cwd(), value: process.env.PROCESS_EXECUTOR_TEST }))),
  ] });
`;

// This implementation must never execute in the controller, or be serialized.
const localTool: ToolDefinition = {
  name: "echo", description: "local metadata", input_schema: { unserializable: 1n },
  execute: async () => { throw new Error("controller tool executed"); },
};

type Executor = ReturnType<typeof createProcessToolExecutor>;
function worker(t: { after(fn: () => Promise<void>): void }, source = fixture, options: Partial<ProcessToolExecutorOptions> = {}) {
  const executor = createProcessToolExecutor({
    command: process.execPath,
    args: ["--import", "tsx", "--input-type=module", "-e", source],
    shutdownTimeoutMs: 150,
    ...options,
  });
  t.after(() => executor.dispose());
  return executor;
}
function call(executor: Executor, name: string, args: Record<string, unknown> = {}, options: {
  signal?: AbortSignal; onChunk?: (chunk: string) => void;
} = {}) {
  return executor.dispatch({ name, args, tool: localTool, context: { signal: options.signal }, onChunk: options.onChunk });
}
function readyCall(executor: Executor, signal?: AbortSignal) {
  let ready!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  const result = call(executor, "wait", {}, { signal, onChunk: () => ready() });
  return { started, result };
}

test("worker allowlist rejects unknown tools, never ships controller code/schema", async t => {
  const executor = worker(t);
  await assert.rejects(call(executor, "unknown"), /Unknown process tool: unknown/);
  await assert.rejects(call(executor, "toString"), /Unknown process tool/);
  await assert.rejects(call(executor, "fail"), /worker failure/);
  assert.deepEqual(await call(executor, "echo", { value: "hello" }), {
    content: '{"value":"hello"}', exitCode: 0, isError: false,
  });
});

test("concurrent calls correlate chunks and out-of-order results", async t => {
  const executor = worker(t);
  const a: string[] = [], b: string[] = [], completed: string[] = [];
  const first = call(executor, "echo", { value: "α\n一", delay: 80 }, { onChunk: chunk => a.push(chunk) })
    .then(result => { completed.push("a"); return result; });
  const second = call(executor, "echo", { value: "b", delay: 1 }, { onChunk: chunk => b.push(chunk) })
    .then(result => { completed.push("b"); return result; });
  const [one, two] = await Promise.all([first, second]);
  assert.equal(JSON.parse(one.content as string).value, "α\n一");
  assert.equal(JSON.parse(two.content as string).value, "b");
  assert.deepEqual(a, ["start:α\n一", "end:α\n一"]);
  assert.deepEqual(b, ["start:b", "end:b"]);
  assert.deepEqual(completed, ["b", "a"]);
});

test("injected tool:dispatch preserves the child's live cancellation signal", async t => {
  const executor = worker(t);
  const core = createCore({});
  t.after(async () => { core.kill(); });
  const ctx = core.extensionContext({ quit() {} });
  ctx.define("tool:dispatch", executor.dispatch);
  const child = new AbortController();
  let ready!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  const result = ctx.call("tool:dispatch", {
    name: "wait", args: {}, tool: localTool, context: { signal: child.signal }, onChunk: () => ready(),
  });
  const reason = new Error("child cancelled");
  const rejected = assert.rejects(result, error => error === reason);
  await started;
  child.abort(reason);
  await rejected;
  // The next request is ordered after cancel on stdin; the worker saw its signal.
  assert.equal((await call(executor, "cancellations")).content, "1");
  assert.equal((await call(executor, "echo", { value: "still alive" })).isError, false);
  const aborted = new AbortController();
  aborted.abort(reason);
  await assert.rejects(call(executor, "wait", {}, { signal: aborted.signal }), error => error === reason);
  assert.equal((await call(executor, "cancellations")).content, "1");
});

test("process death rejects every pending call and subsequent dispatch", async t => {
  const executor = worker(t);
  const first = readyCall(executor);
  const rejected = assert.rejects(first.result, /exited|closed/);
  await first.started;
  const second = call(executor, "wait");
  const secondRejected = assert.rejects(second, /exited|closed/);
  await assert.rejects(call(executor, "exit"), /exited|closed/);
  await Promise.all([rejected, secondRejected]);
  await assert.rejects(call(executor, "echo"), /exited|closed/);
});

test("dispose rejects calls, is idempotent, and escalates past ignored SIGTERM", async t => {
  const source = fixture.replace("let cancellations = 0;", "process.on('SIGTERM', () => {}); let cancellations = 0;");
  const executor = worker(t, source);
  const pending = readyCall(executor);
  const rejected = assert.rejects(pending.result, /disposed/);
  await pending.started;
  const start = Date.now();
  const disposing = executor.dispose();
  assert.equal(executor.dispose(), disposing);
  await disposing;
  await rejected;
  assert.ok(Date.now() - start < 2000, "shutdown is bounded");
  await assert.rejects(call(executor, "echo"), /disposed/);
});

test("executor lifetime signal terminates the process independently of call signals", async t => {
  const lifetime = new AbortController();
  const executor = worker(t, fixture, { signal: lifetime.signal });
  const pending = readyCall(executor);
  const rejected = assert.rejects(pending.result, /lifetime ended/);
  await pending.started;
  lifetime.abort(new Error("lifetime ended"));
  await rejected;
  await executor.dispose();
});

test("spawn failure rejects calls and disposal completes", async t => {
  const executor = worker(t, fixture, { command: `/nonexistent-process-executor-${process.pid}` });
  await assert.rejects(call(executor, "echo"), /ENOENT/);
  await executor.dispose();
});

test("cwd and explicit env reach the executable", async t => {
  const executor = worker(t, fixture, { cwd: process.cwd(), env: { ...process.env, PROCESS_EXECUTOR_TEST: "explicit" } });
  const result = await call(executor, "environment");
  assert.deepEqual(JSON.parse(result.content as string), { cwd: process.cwd(), value: "explicit" });
});

test("outbound oversize and unserializable args reject without corrupting the worker", async t => {
  const executor = worker(t, fixture, { maxMessageBytes: 256 });
  await assert.rejects(call(executor, "echo", { value: "x".repeat(512) }), /maxMessageBytes/);
  await assert.rejects(call(executor, "echo", { value: 1n }), /BigInt/);
  assert.equal((await call(executor, "echo", { value: "small" })).isError, false);
});

test("malformed, oversized unterminated, and truncated child output fail closed", async t => {
  for (const output of ["not-json\n", "x".repeat(257), '{"id":']) {
    const executor = worker(t, `process.stdin.resume(); process.stdout.write(${JSON.stringify(output)}); process.stdout.end();`, {
      maxMessageBytes: 256,
    });
    await assert.rejects(call(executor, "echo"), /JSON|Unexpected|Truncated|maxMessageBytes/);
    await executor.dispose();
  }
});

test("worker accepts split UTF-8 JSONL and enforces input/output bounds", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const received: Buffer[] = [];
  output.on("data", chunk => received.push(chunk));
  const served = serveToolExecutor({ input, output, tools: [{
    ...localTool, execute: async args => ({ content: String(args.value), exitCode: 0, isError: false }),
  }] });
  const response = once(output, "data");
  const request = Buffer.from(JSON.stringify({ id: "1", type: "execute", name: "echo", args: { value: "一" } }) + "\n");
  for (const byte of request) input.write(Buffer.from([byte]));
  await response;
  input.end();
  await served;
  assert.equal(JSON.parse(Buffer.concat(received).toString()).result.content, "一");

  const oversized = new PassThrough();
  const failed = serveToolExecutor({ input: oversized, output: new PassThrough(), tools: [], maxMessageBytes: 32 });
  const rejected = assert.rejects(failed, /maxMessageBytes/);
  oversized.write("x".repeat(33));
  await rejected;

  const slowInput = new PassThrough();
  const slowOutput = new PassThrough({ highWaterMark: 1 });
  const backpressured = serveToolExecutor({ input: slowInput, output: slowOutput, maxQueuedBytes: 1, tools: [] });
  const pressureRejected = assert.rejects(backpressured, /maxQueuedBytes/);
  slowInput.write('{"id":"1","type":"execute","name":"missing","args":{}}\n');
  await pressureRejected;
  input.destroy(); output.destroy(); oversized.destroy(); slowInput.destroy(); slowOutput.destroy();
});

test("worker EOF aborts active contexts and duplicate catalogs are rejected", async () => {
  const input = new PassThrough(), output = new PassThrough();
  let signal: AbortSignal | undefined;
  const served = serveToolExecutor({ input, output, tools: [{
    ...localTool, execute: async (_args, _chunk, ctx) => {
      signal = ctx!.signal;
      return new Promise(() => {});
    },
  }] });
  input.write('{"id":"1","type":"execute","name":"echo","args":{}}\n');
  input.end();
  await served;
  assert.equal(signal?.aborted, true);
  assert.throws(() => serveToolExecutor({ tools: [localTool, localTool] }), /Duplicate process tool/);
  input.destroy(); output.destroy();
});
