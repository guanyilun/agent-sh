/** Programmable, extension-composed agent hosts. Frontends are optional adapters. */
import { createCore } from "../core/index.js";
import { mkdirSync } from "node:fs";
import * as path from "node:path";
import { createScopedContext } from "../core/extension-loader.js";
import { createSettingsService, type Settings, type SettingsService } from "../core/settings.js";
import type { BusEvents } from "../core/event-bus.js";
import type { AppConfig, ExtensionContext } from "../shell/host-types.js";
import type { AgentRunOptions, AgentRunResult, AgentSnapshot } from "../agent/run-contract.js";

export { ashEngine, type AshEngineOptions } from "./ash.js";
export { LlmClient, type LlmClientConfig } from "../agent/llm-client.js";
export { createSettingsService, type SettingsService } from "../core/settings.js";
export { attachAgentSurface } from "../agent/surface.js";
export { localTools } from "./tools.js";
export { delegatedTools } from "./delegation.js";
export { createProcessToolExecutor, serveToolExecutor } from "./process-executor.js";
export type { AgentRunOptions, AgentRunResult, AgentSnapshot, AgentToolDispatcher, AgentToolDispatchInput } from "../agent/run-contract.js";

export interface HostExtension {
  name: string;
  activate(ctx: ExtensionContext): void | Promise<void>;
}

export interface AgentHostOptions {
  cwd: string;
  config?: AppConfig;
  /** Snapshot local defaults/overrides. Session mutations never write global settings. */
  settings?: Partial<Settings>;
  settingsService?: SettingsService;
  /** Optional host-local extension storage root (no directory is created until used). */
  storageRoot?: string;
  /** Explicit, ordered composition. No implicit user discovery or UI built-ins. */
  extensions: HostExtension[];
}

export interface RunResult {
  text: string;
  status: "completed" | "cancelled" | "limited" | "failed";
  error?: string;
  usage: BusEvents["agent:usage"];
  /** Available for native callable backends; legacy event backends lack this data. */
  details?: AgentRunResult;
}

export interface AgentHost {
  readonly id: string;
  readonly context: ExtensionContext;
  readonly settings: SettingsService;
  run(query: string, options?: AgentRunOptions): Promise<RunResult>;
  /** Returns whether the steer was queued for the active run. */
  steer(text: string): boolean;
  cancel(): void;
  snapshot(): Promise<AgentSnapshot>;
  restore(snapshot: AgentSnapshot): Promise<void>;
  /** Creates an explicitly composed owned host. Capability delegation is provided
   * by delegatedTools(), not by copying the parent's context or extension list. */
  createChild(options: AgentHostOptions): Promise<AgentHost>;
  dispose(): Promise<void>;
}

export async function createAgentHost(options: AgentHostOptions): Promise<AgentHost> {
  const settings = options.settingsService ?? createSettingsService(options.settings);
  const core = createCore({ ...options.config, settingsService: settings });
  const disposers: Array<() => Promise<void>> = [];
  const children = new Set<AgentHost>();
  const pendingChildren = new Set<Promise<AgentHost>>();
  let disposed = false;
  let initializing = true;
  let quitRequested = false;
  let cancellationRequested = false;
  let nativeController: AbortController | undefined;
  let active: Promise<RunResult> | undefined;
  let disposePromise: Promise<void> | undefined;
  const ctx = core.extensionContext({ quit: () => {
    if (initializing) quitRequested = true;
    else void host.dispose().catch(() => { /* caller can await dispose for errors */ });
  } });
  core.handlers.define("cwd", () => path.resolve(options.cwd));
  if (options.storageRoot) {
    const root = path.resolve(options.storageRoot);
    ctx.getStoragePath = (namespace) => {
      const directory = path.resolve(root, namespace);
      if (directory !== root && !directory.startsWith(root + path.sep)) throw new Error("Storage namespace escapes host root");
      mkdirSync(directory, { recursive: true });
      return directory;
    };
  }

  // Compatibility for existing event-only backends. Native ash calls agent:run
  // directly; completion is never inferred from unrelated bus events there.
  function runLegacy(query: string, { signal, images }: AgentRunOptions): Promise<RunResult> {
    const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    if (signal?.aborted) return Promise.resolve({ text: "", status: "cancelled", usage });
    let settle!: (result: RunResult) => void;
    const result = new Promise<RunResult>((resolve) => { settle = resolve; });
    // Publish before synchronous backend events can call back into the host.
    active = result;
    cancellationRequested = false;
    const onStart = () => { if (cancellationRequested) host.cancel(); };
    let text = "";
    let error: string | undefined;
    let cancelled = false;
    const onResponse = (event: BusEvents["agent:response-done"]) => { text = event.response; };
    const onError = (event: BusEvents["agent:error"]) => { error = event.message; };
    const onCancelled = () => { cancelled = true; };
    const onUsage = (event: BusEvents["agent:usage"]) => {
      usage.prompt_tokens += event.prompt_tokens;
      usage.completion_tokens += event.completion_tokens;
      usage.total_tokens += event.total_tokens;
    };
    const onAbort = () => { cancelled = true; host.cancel(); };
    const onDone = () => {
      core.bus.off("agent:response-done", onResponse);
      core.bus.off("agent:error", onError);
      core.bus.off("agent:cancelled", onCancelled);
      core.bus.off("agent:usage", onUsage);
      core.bus.off("agent:processing-done", onDone);
      core.bus.off("agent:processing-start", onStart);
      signal?.removeEventListener("abort", onAbort);
      active = undefined;
      settle({ text, status: error ? "failed" : cancelled || cancellationRequested ? "cancelled" : "completed", usage, ...(error ? { error } : {}) });
    };
    core.bus.on("agent:response-done", onResponse);
    core.bus.on("agent:error", onError);
    core.bus.on("agent:cancelled", onCancelled);
    core.bus.on("agent:usage", onUsage);
    core.bus.on("agent:processing-done", onDone);
    core.bus.on("agent:processing-start", onStart);
    signal?.addEventListener("abort", onAbort, { once: true });
    core.bus.emit("agent:submit", { query, images });
    return result;
  }

  const host: AgentHost = {
    id: core.instanceId,
    context: ctx,
    settings,
    run(query, runOptions = {}) {
      if (disposed) return Promise.reject(new Error("Agent host is disposed"));
      if (active) return Promise.reject(new Error("Agent host is busy"));
      if (!ctx.hasBase("agent:run")) return runLegacy(query, runOptions);
      // Publish ownership before invoking any extension callbacks. The controller
      // also captures cancel() called before the engine's first microtask starts.
      const controller = new AbortController();
      nativeController = controller;
      const forwardAbort = () => controller.abort(runOptions.signal?.reason);
      if (runOptions.signal?.aborted) forwardAbort();
      else runOptions.signal?.addEventListener("abort", forwardAbort, { once: true });
      const result = Promise.resolve().then(async (): Promise<RunResult> => {
        const details = await ctx.call("agent:run", { query, ...runOptions, signal: controller.signal }) as AgentRunResult;
        return {
          text: details.text, status: details.stopReason,
          usage: { ...details.usage, cached_prompt_tokens: details.usage.cached_tokens },
          details, ...(details.error ? { error: details.error } : {}),
        };
      });
      active = result;
      void result.finally(() => {
        runOptions.signal?.removeEventListener("abort", forwardAbort);
        if (nativeController === controller) nativeController = undefined;
        if (active === result) active = undefined;
      }).catch(() => {});
      return result;
    },
    steer(text) {
      if (disposed || !active) throw new Error("Steering requires an active run");
      if (nativeController) {
        // run() reserves the host before its engine microtask begins. Queue a
        // synchronous steer behind that invocation, never start a legacy turn.
        const target = active;
        let accepted = false;
        queueMicrotask(() => {
          try { if (active === target && !disposed) accepted = ctx.call("agent:steer-active", text) === true; }
          catch { /* advisor faults drop the steer */ }
        });
        return accepted;
      }
      core.bus.emit("agent:steer", { text });
      return true;
    },
    cancel() {
      if (active) {
        cancellationRequested = true;
        nativeController?.abort();
        core.bus.emit("agent:cancel-request", { silent: false });
      }
    },
    async snapshot() {
      if (disposed || active) throw new Error("Snapshot requires an idle host");
      if (!ctx.hasBase("agent:snapshot")) throw new Error("Backend does not support snapshots");
      return ctx.call("agent:snapshot");
    },
    async restore(snapshot) {
      if (disposed || active) throw new Error("Restore requires an idle host");
      if (!ctx.hasBase("agent:restore")) throw new Error("Backend does not support restore");
      await ctx.call("agent:restore", snapshot);
    },
    async createChild(childOptions) {
      if (disposed) throw new Error("Agent host is disposed");
      const pending = createAgentHost({ ...childOptions, settings: { ...settings.get(), ...childOptions.settings } });
      pendingChildren.add(pending);
      try {
        const child = await pending;
        children.add(child);
        const disposeChild = child.dispose.bind(child);
        child.dispose = () => {
          const disposal = disposeChild();
          void disposal.finally(() => children.delete(child)).catch(() => {});
          return disposal;
        };
        if (disposed) { await child.dispose(); throw new Error("Parent disposed during child creation"); }
        return child;
      } finally { pendingChildren.delete(pending); }
    },
    dispose() {
      if (!disposePromise) {
        disposed = true;
        disposePromise = Promise.resolve().then(async () => {
          const errors: unknown[] = [];
          const pending = active;
          host.cancel();
          const attempted = async (fn: () => unknown) => { try { await fn(); } catch (error) { errors.push(error); } };
          // Cancel existing children immediately: an initializing sibling may
          // itself be awaiting their cooperative completion.
          const childDisposal = Promise.all([...children].map(child => attempted(() => child.dispose())));
          await Promise.all([...pendingChildren].map(p => p.catch(() => undefined)));
          await childDisposal;
          await Promise.all([...children].map(child => attempted(() => child.dispose())));
          children.clear();
          await attempted(() => pending);
          if (ctx.hasBase("agent:dispose")) await attempted(() => ctx.call("agent:dispose"));
          await attempted(() => core.kill());
          for (const dispose of disposers.reverse()) await attempted(dispose);
          if (errors.length === 1) throw errors[0];
          if (errors.length > 1) throw new AggregateError(errors, "Agent host disposal failed");
        });
      }
      return disposePromise;
    },
  };

  try {
    for (const extension of options.extensions) {
      const { scoped, disposeAsync } = createScopedContext(ctx, extension.name);
      disposers.push(disposeAsync);
      await extension.activate(scoped);
      if (quitRequested) throw new Error("Agent host quit during initialization");
    }
    core.bus.emit("core:extensions-loaded", { names: options.extensions.map((e) => e.name) });
    const backends = core.bus.emitPipe("config:get-backends", { names: [], active: null });
    const selected = options.config?.backend;
    if (!backends.names.length || (selected && !backends.names.includes(selected))) {
      throw new Error(selected ? `Backend not registered: ${selected}` : "No agent backend registered");
    }
    if (quitRequested) throw new Error("Agent host quit during initialization");
    await core.activateBackend(selected);
    if (quitRequested) throw new Error("Agent host quit during initialization");
    initializing = false;
    return host;
  } catch (error) {
    initializing = false;
    try { await host.dispose(); } catch { /* preserve the initialization failure */ }
    throw error;
  }
}
