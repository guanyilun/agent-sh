// Loader at pi-sdk-mock-loader.mjs reroutes `@mariozechner/pi-coding-agent`
// here so the bridge and tests share this module instance.

let capturedSubscriber = null;
let queuedEvents = [];
const promptCalls = [];
const abortCalls = [];

export function __reset() {
  capturedSubscriber = null;
  queuedEvents = [];
  promptCalls.length = 0;
  abortCalls.length = 0;
}

export function __emit(event) {
  if (capturedSubscriber) {
    capturedSubscriber(event);
  } else {
    queuedEvents.push(event);
  }
}

export function __promptCalls() {
  return promptCalls.slice();
}

export function __abortCalls() {
  return abortCalls.slice();
}

const fakeSession = {
  subscribe(fn) {
    capturedSubscriber = fn;
    while (queuedEvents.length > 0) fn(queuedEvents.shift());
  },
  async prompt(text) {
    promptCalls.push(text);
  },
  async abort() {
    abortCalls.push(Date.now());
  },
  async compact() {},
  getContextUsage() {
    return { tokens: 0, contextWindow: 100_000 };
  },
  model: { provider: "stub", id: "stub-model" },
};

const fakeRuntime = {
  session: fakeSession,
  async newSession() {},
};

export class SessionManager {
  static inMemory() {
    return new SessionManager();
  }
}

export async function createAgentSessionServices() {
  return {
    modelRegistry: {
      getAvailable: () => [{ id: "stub-model", provider: "stub" }],
    },
  };
}

export async function createAgentSessionFromServices() {
  return { session: fakeSession };
}

export async function createAgentSessionRuntime(createRuntime, opts) {
  await createRuntime({ ...opts, sessionManager: opts.sessionManager });
  return fakeRuntime;
}
