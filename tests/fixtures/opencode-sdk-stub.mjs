// Loader at opencode-sdk-mock-loader.mjs reroutes `@opencode-ai/sdk/v2`
// here so the bridge and tests share this module instance.

const STUB_SESSION_ID = "stub-session-id";

class EventStream {
  constructor() {
    this.queue = [];
    this.resolvers = [];
    this.closed = false;
  }

  push(event) {
    if (this.closed) return;
    if (this.resolvers.length > 0) {
      const resolve = this.resolvers.shift();
      resolve({ value: event, done: false });
    } else {
      this.queue.push(event);
    }
  }

  close() {
    this.closed = true;
    while (this.resolvers.length > 0) {
      const resolve = this.resolvers.shift();
      resolve({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator]() {
    return {
      next: () => {
        if (this.queue.length > 0) {
          return Promise.resolve({ value: this.queue.shift(), done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise((resolve) => this.resolvers.push(resolve));
      },
    };
  }
}

// Don't close old streams on reset: closing wakes orphan bridges from prior
// tests, which then re-subscribe and steal events from the current test.
let activeStream = null;
const promptCalls = [];
const abortCalls = [];
const questionReplies = [];
const permissionReplies = [];

export function __reset() {
  activeStream = null;
  promptCalls.length = 0;
  abortCalls.length = 0;
  questionReplies.length = 0;
  permissionReplies.length = 0;
}

export function __emitEvent(event) {
  if (!activeStream) return;
  if (event && typeof event === "object" && event.properties && !("sessionID" in event.properties)) {
    event.properties.sessionID = STUB_SESSION_ID;
  }
  activeStream.push(event);
}

export function __sessionId() {
  return STUB_SESSION_ID;
}

export function __promptCalls() { return promptCalls.slice(); }
export function __abortCalls() { return abortCalls.slice(); }
export function __questionReplies() { return questionReplies.slice(); }
export function __permissionReplies() { return permissionReplies.slice(); }

const client = {
  event: {
    subscribe: async () => {
      activeStream = new EventStream();
      return { stream: activeStream };
    },
  },
  session: {
    create: async ({ directory }) => ({ data: { id: STUB_SESSION_ID, directory } }),
    prompt: async ({ sessionID, directory, parts }) => {
      promptCalls.push({ sessionID, directory, parts });
      return { data: { parts: [] } };
    },
    abort: async ({ sessionID, directory }) => {
      abortCalls.push({ sessionID, directory });
    },
  },
  question: {
    reply: async (args) => { questionReplies.push(args); },
    reject: async (args) => { questionReplies.push({ ...args, rejected: true }); },
  },
  permission: {
    reply: async (args) => { permissionReplies.push(args); },
  },
};

const server = {
  url: "http://stub.local",
  close() {},
};

export async function createOpencode() {
  return { client, server };
}
