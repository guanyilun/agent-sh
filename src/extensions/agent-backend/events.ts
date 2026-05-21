/**
 * Event types owned by the agent-backend extension. Augments core's
 * ShellEvents via TypeScript declaration merging — core knows nothing
 * about agents or backends; this module is the source of truth for
 * the backend-registry events and the identity pipe.
 *
 * Backends keep their existing emit API (`bus.emit("agent:info", ...)`)
 * — that's the producer-side legacy contract. agent-backend listens to
 * those events, filters by name === activeBackend (drops stale
 * emissions from non-active backends), and republishes via the canonical
 * identity pipe + transition poke for consumers.
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

    // Legacy producer channel — backends emit their identity here.
    // agent-backend filters by name === active and republishes
    // through the identity pipe. Kept as a separate event from the
    // pipe so bridges built against the prior API keep working.
    "agent:info": AgentIdentity;

    // Canonical consumer channel. Active backend's identity, filtered
    // by agent-backend; stale emissions from inactive backends are
    // dropped before reaching consumers.
    "agent:identity": { identity: AgentIdentity | null };
    // Transition poke. Emitted whenever the identity pipe answer
    // might have changed (backend switch, active-backend agent:info).
    "agent:identity-changed": Record<string, never>;
  }
}

export {};
