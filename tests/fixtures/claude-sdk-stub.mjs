// Loader at claude-sdk-mock-loader.mjs reroutes `@anthropic-ai/claude-agent-sdk`
// here so the bridge and tests share this module instance.

const queryCalls = [];
let activeIterator = null;

class QueryIterator {
  constructor() {
    this.queue = [];
    this.resolvers = [];
    this.done = false;
    this.interrupted = false;
  }

  push(message) {
    if (this.done) return;
    if (this.resolvers.length > 0) {
      this.resolvers.shift()({ value: message, done: false });
    } else {
      this.queue.push(message);
    }
  }

  close() {
    this.done = true;
    while (this.resolvers.length > 0) {
      this.resolvers.shift()({ value: undefined, done: true });
    }
  }

  interrupt() {
    this.interrupted = true;
    this.close();
  }

  [Symbol.asyncIterator]() {
    return this;
  }

  next() {
    if (this.queue.length > 0) {
      return Promise.resolve({ value: this.queue.shift(), done: false });
    }
    if (this.done) {
      return Promise.resolve({ value: undefined, done: true });
    }
    return new Promise((resolve) => this.resolvers.push(resolve));
  }
}

export function __reset() {
  queryCalls.length = 0;
  activeIterator = null;
}

export function __queryCalls() {
  return queryCalls.slice();
}

export function __pushMessage(msg) {
  if (activeIterator) activeIterator.push(msg);
}

export function __endQuery() {
  if (activeIterator) activeIterator.close();
}

export function __wasInterrupted() {
  return activeIterator?.interrupted ?? false;
}

export function query(opts) {
  queryCalls.push(opts);
  activeIterator = new QueryIterator();
  return activeIterator;
}
