/**
 * Event types owned by the agent-backend extension. Augments core's
 * ShellEvents via TypeScript declaration merging — core knows nothing
 * about agents or backends; this module is the source of truth for
 * the backend-registry events and the identity pipe.
 *
 * Identity uses pull-composition: backends install
 * `onPipe("agent:identity", ...)` handlers in their own start(),
 * remove them in kill(). The transition poke `agent:identity-changed`
 * tells consumers to re-pull. Inactive backends contribute nothing.
 *
 * Future slices will migrate the rest of the agent:* namespace
 * (submit, response, tool-*, etc.) here as well; for this initial cut
 * we only own the events the extension actually wires.
 *
 * Any module that consumes these events must transitively import
 * this file so TypeScript sees the augmented map.
 */

/** Stable identity of whichever backend is currently active. */
export interface AgentIdentity {
  name: string;
  version: string;
  model?: string;
  provider?: string;
  contextWindow?: number;
}

/** Registration payload backends use to enroll themselves. */
export interface BackendRegistration {
  name: string;
  kill: () => void;
  start?: () => Promise<void>;
}

declare module "../../core/event-bus.js" {
  interface ShellEvents {
    // Backend registry / lifecycle
    "agent:register-backend": BackendRegistration;
    "config:switch-backend": { name: string };
    "config:list-backends": Record<string, never>;
    "config:get-backends": { names: string[]; active: string | null };

    // Pull-composition: the active backend installs an onPipe handler
    // in start() and removes it in kill(). Consumers call emitPipe
    // to snapshot the current identity; the transition poke tells
    // them when to re-pull.
    "agent:identity": { identity: AgentIdentity | null };
    "agent:identity-changed": Record<string, never>;
  }
}

export {};
