/**
 * Agent-backend built-in extension.
 *
 * Owns the abstract concept of "agent backend": registration, switching,
 * identity. Specific backends (ash, claude-code-bridge, pi-bridge,
 * opencode-bridge, ...) register themselves through it; they bring
 * their own LLM and tools.
 *
 * Identity is filtered at this layer: backends keep emitting their
 * legacy `agent:info` events (no API change for installed bridges),
 * agent-backend drops any emission whose name doesn't match the
 * currently active backend, and republishes the survivor through the
 * canonical `agent:identity` pipe. Stale ash emissions from
 * pre-`wire()` listeners can no longer overwrite the active backend's
 * label — not by guard, by construction at the gatekeeper.
 *
 * Core knows nothing about agents. This extension is the home of the
 * `agent:*` event namespace and the backend registry.
 *
 * Loaded as a built-in (peer to shell-context, tui-renderer) so
 * backends — which often activate via `core:extensions-loaded` — find
 * the registry already wired.
 */
import "./events.js"; // augments ShellEvents
import type { ExtensionContext } from "../../shell/host-types.js";
import type { BackendRegistration, AgentIdentity } from "./events.js";
import * as settingsMod from "../../core/settings.js";

export default function activate(ctx: ExtensionContext): void {
  const { bus } = ctx;

  const backends = new Map<string, BackendRegistration>();
  let activeBackendName: string | null = null;
  // Latest legacy `agent:info` emission from the active backend.
  // Cleared on backend switch; updated on every accepted emission.
  let activeIdentity: AgentIdentity | null = null;

  const activateByName = async (name: string): Promise<boolean> => {
    const backend = backends.get(name);
    if (!backend) {
      bus.emit("ui:error", { message: `Unknown backend: ${name}` });
      return false;
    }
    if (activeBackendName) {
      backends.get(activeBackendName)?.kill();
    }
    activeBackendName = name;
    // Reset before start() — the new backend's first agent:info
    // emission populates activeIdentity through the filter below.
    activeIdentity = null;
    await backend.start?.();
    bus.emit("agent:identity-changed", {});
    return true;
  };

  bus.on("agent:register-backend", (backend) => {
    backends.set(backend.name, backend);
  });

  bus.on("config:switch-backend", ({ name }) => {
    activateByName(name).then((ok) => {
      if (!ok) return;
      settingsMod.updateSettings({ defaultBackend: name });
      bus.emit("ui:info", { message: `Backend: ${name} (saved as default)` });
      bus.emit("config:changed", {});
    });
  });

  bus.on("config:list-backends", () => {
    const names = [...backends.keys()];
    const list = names
      .map((n) => n === activeBackendName ? `${n} (active)` : n)
      .join(", ");
    bus.emit("ui:info", { message: `Backends: ${list}` });
  });

  bus.onPipe("config:get-backends", () => ({
    names: [...backends.keys()],
    active: activeBackendName,
  }));

  // Identity gatekeeper — the structural fix for stale-identity leaks.
  // Stale emissions (e.g. ash's eagerly-constructed AgentLoop reacting
  // to a provider catalog update while claude-code is the active
  // backend) get dropped here before reaching any consumer.
  bus.on("agent:info", (info) => {
    if (info.name !== activeBackendName) return;
    activeIdentity = info;
    bus.emit("agent:identity-changed", {});
  });

  // Canonical consume channel: the pipe returns the filtered identity.
  // Backends that prefer the pull-composition style can chain their
  // own onPipe handlers to override or extend (last writer wins on
  // `acc.identity`).
  bus.onPipe("agent:identity", (acc) => {
    if (activeIdentity) acc.identity = activeIdentity;
    return acc;
  });

  // Hosts call this through the extension API rather than the bus
  // (one-shot, sync-await activation, not a recurring command).
  ctx.define("agent-backend:activate", async (override?: string) => {
    if (backends.size === 0) return;
    const settings = settingsMod.getSettings();
    const preferred = override ?? settings.defaultBackend;
    const name = preferred && backends.has(preferred)
      ? preferred
      : backends.keys().next().value!;
    await activateByName(name);
  });

  ctx.define("agent-backend:identity", (): AgentIdentity | null => {
    return bus.emitPipe("agent:identity", { identity: null }).identity;
  });

  // Core's kill() calls this on process teardown.
  ctx.define("agent-backend:kill", () => {
    if (activeBackendName) {
      backends.get(activeBackendName)?.kill();
      activeBackendName = null;
      activeIdentity = null;
    }
  });
}
