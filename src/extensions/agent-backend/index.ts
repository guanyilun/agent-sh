/**
 * Owns the abstract concept of "agent backend": registration,
 * switching, identity. Loaded as a built-in before any specific
 * backend (ash, bridges) so backends find the registry already wired
 * when they register themselves via `core:extensions-loaded`.
 */
import "./events.js"; // augments ShellEvents
import type { ExtensionContext } from "../../shell/host-types.js";
import type { BackendRegistration } from "./events.js";
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

  ctx.define("agent-backend:activate", async (override?: string) => {
    if (backends.size === 0) return;
    const settings = settingsMod.getSettings();
    const preferred = override ?? settings.defaultBackend;
    const name = preferred && backends.has(preferred)
      ? preferred
      : backends.keys().next().value!;
    await activateByName(name);
  });

  ctx.define("agent-backend:kill", () => {
    if (activeBackendName) {
      backends.get(activeBackendName)?.kill();
      activeBackendName = null;
    }
  });
}
