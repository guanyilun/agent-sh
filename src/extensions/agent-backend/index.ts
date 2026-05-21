/**
 * Agent-backend built-in extension.
 *
 * Owns the abstract concept of "agent backend": registration, switching,
 * identity. Specific backends (ash, claude-code-bridge, pi-bridge,
 * opencode-bridge, ...) register themselves through it; they bring
 * their own LLM and tools.
 *
 * Identity is pull-composition: each backend installs an
 * `onPipe("agent:identity", ...)` contributor in its start() and
 * removes it in kill(). Consumers call emitPipe on the transition
 * poke. Inactive backends contribute nothing — stale identity from
 * pre-wire() listeners is structurally impossible because the
 * contributor isn't installed.
 *
 * Core knows nothing about agents. This extension is the home of the
 * `agent:*` event namespace and the backend registry.
 *
 * Loaded as a built-in so backends — which often activate via
 * `core:extensions-loaded` — find the registry already wired.
 */
import "./events.js"; // augments ShellEvents
import type { ExtensionContext } from "../../shell/host-types.js";
import type { BackendRegistration, AgentIdentity } from "./events.js";
import * as settingsMod from "../../core/settings.js";

export default function activate(ctx: ExtensionContext): void {
  const { bus } = ctx;

  const backends = new Map<string, BackendRegistration>();
  let activeBackendName: string | null = null;

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
    }
  });
}
