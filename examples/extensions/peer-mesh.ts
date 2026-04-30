/**
 * Peer mesh — cross-instance discovery + RPC over Unix sockets.
 *
 * Each running ash exposes a small set of named handlers; tools let the
 * agent enumerate peers, read another peer's terminal, drive its keys,
 * send messages, and ask synchronous questions.
 *
 * Usage:
 *   ash -e ./examples/extensions/peer-mesh.ts
 *   cp examples/extensions/peer-mesh.ts ~/.agent-sh/extensions/
 */
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionContext } from "agent-sh/types";

interface PeerInfo {
  id: string;
  pid: number;
  cwd: string;
  socketPath: string;
  startTime: number;
}

interface RpcRequest { method: string; args: unknown[]; }
interface RpcResponse { ok: boolean; result?: unknown; error?: string; }
interface InboxEntry { from: string; text: string; at: number; }

const PEERS_DIR = path.join(os.homedir(), ".agent-sh", "peers");
const MAX_SEND_BYTES = 2048;
const DEFAULT_TIMEOUT_MS = 5_000;
const ASK_TIMEOUT_MS = 120_000;
const ASK_QUEUE_MAX = 3;
const SETTLE_MS = 400;
const IDLE_GUARD_MS = 500;
const INBOX_MAX = 100;
const LONG_TIMEOUT_METHODS = new Set<string>(["peer:ask"]);

function peerFilePath(id: string): string {
  return path.join(PEERS_DIR, `${id}.json`);
}

function socketPath(pid: number): string {
  return path.join(os.tmpdir(), `agent-sh-peer-${pid}.sock`);
}

// Expand backslash escapes so callers can send Enter / Ctrl-keys via JSON.
function interpretEscapes(s: string): string {
  return s.replace(/\\(x[0-9a-fA-F]{2}|r|n|t|\\|0)/g, (_, seq: string) => {
    if (seq === "r") return "\r";
    if (seq === "n") return "\n";
    if (seq === "t") return "\t";
    if (seq === "\\") return "\\";
    if (seq === "0") return "\0";
    if (seq.startsWith("x")) return String.fromCharCode(parseInt(seq.slice(1), 16));
    return seq;
  });
}

class PeerServer {
  private server: net.Server | null = null;
  private exposed = new Set<string>();
  private readonly info: PeerInfo;
  private readonly callHandler: (name: string, ...args: unknown[]) => unknown;

  constructor(
    instanceId: string,
    cwd: string,
    callHandler: (name: string, ...args: unknown[]) => unknown,
  ) {
    this.callHandler = callHandler;
    this.info = {
      id: instanceId,
      pid: process.pid,
      cwd,
      socketPath: socketPath(process.pid),
      startTime: Date.now(),
    };
  }

  start(): void {
    fs.mkdirSync(PEERS_DIR, { recursive: true });
    try { fs.unlinkSync(this.info.socketPath); } catch {}
    this.server = net.createServer((conn) => this.handleConnection(conn));
    this.server.on("error", () => {});
    this.server.listen(this.info.socketPath);
    fs.writeFileSync(peerFilePath(this.info.id), JSON.stringify(this.info));
    const cleanup = () => this.stop();
    process.on("exit", cleanup);
    process.on("SIGTERM", () => { cleanup(); process.exit(0); });
    process.on("SIGINT", () => { cleanup(); process.exit(0); });
  }

  stop(): void {
    if (this.server) { try { this.server.close(); } catch {} this.server = null; }
    try { fs.unlinkSync(this.info.socketPath); } catch {}
    try { fs.unlinkSync(peerFilePath(this.info.id)); } catch {}
  }

  expose(name: string): void { this.exposed.add(name); }

  updateCwd(cwd: string): void {
    this.info.cwd = cwd;
    try { fs.writeFileSync(peerFilePath(this.info.id), JSON.stringify(this.info)); } catch {}
  }

  discover(): PeerInfo[] {
    const peers: PeerInfo[] = [];
    let entries: string[];
    try { entries = fs.readdirSync(PEERS_DIR); } catch { return []; }
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      try {
        const info: PeerInfo = JSON.parse(fs.readFileSync(path.join(PEERS_DIR, entry), "utf-8"));
        if (info.id === this.info.id) continue;
        try { process.kill(info.pid, 0); } catch {
          try { fs.unlinkSync(path.join(PEERS_DIR, entry)); } catch {}
          continue;
        }
        peers.push(info);
      } catch { /* skip */ }
    }
    return peers;
  }

  async call(peerId: string, method: string, ...args: unknown[]): Promise<unknown> {
    const peer = this.discover().find((p) => p.id === peerId);
    if (!peer) throw new Error(`Peer "${peerId}" not found`);
    return this.callSocket(peer.socketPath, method, args);
  }

  private handleConnection(conn: net.Socket): void {
    let buffer = "";
    conn.on("data", async (data) => {
      buffer += data.toString();
      const newlineIdx = buffer.indexOf("\n");
      if (newlineIdx === -1) return;
      const line = buffer.slice(0, newlineIdx);
      buffer = buffer.slice(newlineIdx + 1);
      let response: RpcResponse;
      try {
        const req: RpcRequest = JSON.parse(line);
        if (!this.exposed.has(req.method)) {
          response = { ok: false, error: `Handler "${req.method}" is not exposed` };
        } else {
          const result = await this.callHandler(req.method, ...(req.args ?? []));
          response = { ok: true, result };
        }
      } catch (e) {
        response = { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
      try { conn.write(JSON.stringify(response) + "\n"); } catch {}
      conn.end();
    });
    conn.on("error", () => {});
    conn.setTimeout(ASK_TIMEOUT_MS + 5_000, () => conn.destroy());
  }

  private callSocket(sockPath: string, method: string, args: unknown[]): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const conn = net.createConnection(sockPath);
      let buffer = "";
      let settled = false;
      const settle = (fn: () => void) => { if (!settled) { settled = true; fn(); } };
      conn.on("connect", () => {
        const req: RpcRequest = { method, args };
        conn.write(JSON.stringify(req) + "\n");
      });
      conn.on("data", (data) => {
        buffer += data.toString();
        const newlineIdx = buffer.indexOf("\n");
        if (newlineIdx === -1) return;
        try {
          const resp: RpcResponse = JSON.parse(buffer.slice(0, newlineIdx));
          settle(() => resp.ok ? resolve(resp.result) : reject(new Error(resp.error)));
        } catch (e) {
          settle(() => reject(e));
        }
        conn.end();
      });
      conn.on("error", (e) => settle(() => reject(e)));
      const timeout = LONG_TIMEOUT_METHODS.has(method) ? ASK_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
      conn.setTimeout(timeout, () => settle(() => {
        reject(new Error(`Peer call timed out after ${timeout}ms`));
        conn.destroy();
      }));
    });
  }
}

export default function activate(ctx: ExtensionContext): void {
  const { bus, registerCommand, registerTool, registerInstruction, define } = ctx;
  const getCwd = () => ctx.call("cwd") as string;
  const startTime = Date.now();

  const server = new PeerServer(ctx.instanceId, getCwd(), (...args) => ctx.call(...args));
  server.start();

  // Track PTY idle window so peer:terminal-send doesn't stomp on a busy shell.
  let lastPtyOutputTs = startTime;
  bus.on("shell:pty-data", () => { lastPtyOutputTs = Date.now(); });

  define("peer:info", () => ({
    id: ctx.instanceId,
    pid: process.pid,
    cwd: getCwd(),
    uptime: Math.round((Date.now() - startTime) / 1000),
  }));
  server.expose("peer:info");

  define("peer:terminal-read", () => {
    const tb = ctx.terminalBuffer;
    if (!tb) return { text: "(terminal buffer not available)", altScreen: false };
    return tb.readScreen({ includeScrollback: true });
  });
  server.expose("peer:terminal-read");

  define("peer:terminal-send", async (keys: string, requireIdleMs?: number, settleMs?: number) => {
    if (typeof keys !== "string" || keys.length === 0) {
      throw new Error("peer:terminal-send requires non-empty keys string");
    }
    if (Buffer.byteLength(keys, "utf-8") > MAX_SEND_BYTES) {
      throw new Error(`keys payload exceeds ${MAX_SEND_BYTES} bytes`);
    }
    const threshold = typeof requireIdleMs === "number" ? requireIdleMs : IDLE_GUARD_MS;
    const idleMs = Date.now() - lastPtyOutputTs;
    if (idleMs < threshold) {
      return { sent: false, reason: "not_idle", idle_ms: idleMs, required_ms: threshold };
    }
    bus.emit("shell:pty-write", { data: interpretEscapes(keys) });
    await new Promise((r) => setTimeout(r, typeof settleMs === "number" ? settleMs : SETTLE_MS));
    const tb = ctx.terminalBuffer;
    return { sent: true, screen: tb ? tb.readScreen({ includeScrollback: false }) : null };
  });
  server.expose("peer:terminal-send");

  // Forwards to the shell-context built-in. If shell-context isn't loaded
  // (e.g. headless frontend), the underlying handler is undefined and these
  // calls degrade to a clear error to the requesting peer.
  define("peer:context-recent", (n: number = 15) => ctx.call("shell:context-recent", n));
  server.expose("peer:context-recent");

  define("peer:context-search", (query: string) => ctx.call("shell:context-search", query));
  server.expose("peer:context-search");

  // ── Inbox + drained turn ──────────────────────────────────────
  const inbox: InboxEntry[] = [];
  const pending: InboxEntry[] = [];
  let busy = false;

  function drainPending(): void {
    if (busy || pending.length === 0) return;
    const batch = pending.splice(0, pending.length);
    const lines = batch.map((e) => `[from peer ${e.from}] ${e.text}`);
    busy = true;
    bus.emit("agent:submit", {
      query: [
        "You received message(s) from other peer(s) in the mesh:",
        "",
        ...lines,
        "",
        "Decide whether to reply (via `peer_send`), act on the request, or note and continue.",
      ].join("\n"),
    });
  }

  bus.on("agent:processing-done", () => { busy = false; setTimeout(drainPending, 100); });

  define("peer:message", (from: string, text: string) => {
    if (typeof from !== "string" || typeof text !== "string") {
      throw new Error("peer:message requires (from: string, text: string)");
    }
    if (Buffer.byteLength(text, "utf-8") > MAX_SEND_BYTES) {
      throw new Error(`text payload exceeds ${MAX_SEND_BYTES} bytes`);
    }
    const entry: InboxEntry = { from, text, at: Date.now() };
    inbox.push(entry);
    if (inbox.length > INBOX_MAX) inbox.splice(0, inbox.length - INBOX_MAX);
    pending.push(entry);
    bus.emit("ui:info", { message: `[peer ${from}] ${text}` });
    setTimeout(drainPending, 100);
    return { ok: true };
  });
  server.expose("peer:message");

  // ── Synchronous Q&A: peer A asks B, blocks until B's next turn answers ──
  interface AskSlot { resolve: (answer: string) => void; reject: (e: Error) => void; from: string; question: string; }
  const askQueue: AskSlot[] = [];

  define("peer:ask", (from: string, question: string) => {
    if (typeof from !== "string" || typeof question !== "string") {
      throw new Error("peer:ask requires (from: string, question: string)");
    }
    if (askQueue.length >= ASK_QUEUE_MAX) {
      throw new Error(`peer:ask queue full (max ${ASK_QUEUE_MAX})`);
    }
    if (Buffer.byteLength(question, "utf-8") > MAX_SEND_BYTES) {
      throw new Error(`question payload exceeds ${MAX_SEND_BYTES} bytes`);
    }
    return new Promise<string>((resolve, reject) => {
      const slot: AskSlot = { resolve, reject, from, question };
      askQueue.push(slot);
      const timer = setTimeout(() => {
        const idx = askQueue.indexOf(slot);
        if (idx >= 0) askQueue.splice(idx, 1);
        reject(new Error("peer:ask timed out"));
      }, ASK_TIMEOUT_MS);
      bus.emit("ui:info", { message: `[peer ${from} asks] ${question}` });
      bus.emit("agent:submit", {
        query: [
          `Peer ${from} asks: ${question}`,
          "",
          "Answer with `peer_answer` (your reply will be returned synchronously).",
        ].join("\n"),
      });
      // Once resolved/rejected by peer_answer, clear the timer.
      const origResolve = slot.resolve;
      const origReject = slot.reject;
      slot.resolve = (a) => { clearTimeout(timer); origResolve(a); };
      slot.reject = (e) => { clearTimeout(timer); origReject(e); };
    });
  });
  server.expose("peer:ask");

  // ── Tools ─────────────────────────────────────────────────────
  registerTool({
    name: "peers",
    description: "List all running agent-sh instances that can be communicated with.",
    input_schema: { type: "object", properties: {}, required: [] },
    showOutput: false,
    getDisplayInfo: () => ({ kind: "search" as const }),
    formatCall: () => "discovering peers",
    async execute() {
      const peers = server.discover();
      if (peers.length === 0) {
        return { content: "No other agent-sh instances found.", exitCode: 0, isError: false };
      }
      const lines = peers.map((p) =>
        `- id: ${p.id}, pid: ${p.pid}, cwd: ${p.cwd}, uptime: ${Math.round((Date.now() - p.startTime) / 1000)}s`,
      );
      return { content: `Found ${peers.length} peer(s):\n${lines.join("\n")}`, exitCode: 0, isError: false };
    },
    formatResult: (_a, r) => ({ summary: r.content.startsWith("No") ? "none found" : r.content.split("\n")[0] }),
  });

  registerTool({
    name: "peer_terminal",
    description: "Read the terminal screen content of another running agent-sh instance.",
    input_schema: {
      type: "object",
      properties: { peer_id: { type: "string", description: "Instance ID of the peer (from `peers`)." } },
      required: ["peer_id"],
    },
    showOutput: false,
    getDisplayInfo: () => ({ kind: "read" as const }),
    formatCall: (a) => `peer ${a.peer_id}`,
    async execute(args) {
      try {
        const screen = await server.call(args.peer_id as string, "peer:terminal-read") as any;
        const text = screen?.text?.trim() || "(empty screen)";
        const alt = screen?.altScreen ? " [alternate screen active]" : "";
        return { content: `Terminal content from peer ${args.peer_id}${alt}:\n\n${text}`, exitCode: 0, isError: false };
      } catch (e) {
        return { content: `Failed to read peer terminal: ${e instanceof Error ? e.message : String(e)}`, exitCode: 1, isError: true };
      }
    },
    formatResult: (_a, r) => ({ summary: r.isError ? "failed" : `${r.content.split("\n").length - 2} lines` }),
  });

  registerTool({
    name: "peer_terminal_send",
    description:
      "Type keys into another peer's terminal PTY. Supports backslash escapes " +
      "(`\\r` for Enter, `\\n`, `\\t`, `\\xNN` for raw bytes, `\\\\` for literal backslash). " +
      "Refuses to send if the peer's PTY produced output within the idle threshold (default 500ms).",
    input_schema: {
      type: "object",
      properties: {
        peer_id: { type: "string", description: "Instance ID of the peer." },
        keys: { type: "string", description: "Key sequence to send. Append `\\r` to submit a command." },
        require_idle_ms: { type: "number", description: "Refuse if peer was active within this many ms (default 500)." },
        settle_ms: { type: "number", description: "Wait this long after sending before reading the screen back (default 400)." },
      },
      required: ["peer_id", "keys"],
    },
    showOutput: false,
    getDisplayInfo: () => ({ kind: "write" as const }),
    formatCall: (a) => `peer ${a.peer_id}: ${JSON.stringify(String(a.keys).slice(0, 40))}`,
    async execute(args) {
      try {
        const result = await server.call(
          args.peer_id as string,
          "peer:terminal-send",
          args.keys,
          args.require_idle_ms,
          args.settle_ms,
        ) as { sent: boolean; reason?: string; idle_ms?: number; required_ms?: number; screen?: { text: string } | null };
        if (!result.sent) {
          return {
            content: `Refused to send: peer is busy (${result.reason}; idle ${result.idle_ms}ms / required ${result.required_ms}ms).`,
            exitCode: 1,
            isError: true,
          };
        }
        const screen = result.screen?.text?.trim() ?? "(no screen capture)";
        return { content: `Sent. Screen after settle:\n\n${screen}`, exitCode: 0, isError: false };
      } catch (e) {
        return { content: `Failed to send keys: ${e instanceof Error ? e.message : String(e)}`, exitCode: 1, isError: true };
      }
    },
    formatResult: (_a, r) => ({ summary: r.isError ? "failed" : "sent" }),
  });

  registerTool({
    name: "peer_history",
    description: "Get the recent shell command history from another running agent-sh instance.",
    input_schema: {
      type: "object",
      properties: {
        peer_id: { type: "string" },
        count: { type: "number", description: "Number of recent exchanges (default 15)." },
      },
      required: ["peer_id"],
    },
    showOutput: false,
    getDisplayInfo: () => ({ kind: "read" as const }),
    formatCall: (a) => `peer ${a.peer_id}`,
    async execute(args) {
      try {
        const summary = await server.call(args.peer_id as string, "peer:context-recent", (args.count as number) || 15) as string;
        return { content: summary || "(no history)", exitCode: 0, isError: false };
      } catch (e) {
        return { content: `Failed to read peer history: ${e instanceof Error ? e.message : String(e)}`, exitCode: 1, isError: true };
      }
    },
    formatResult: (_a, r) => ({ summary: r.isError ? "failed" : `${r.content.split("\n").length} lines` }),
  });

  registerTool({
    name: "peer_search",
    description: "Search another agent-sh instance's shell context by keyword or regex.",
    input_schema: {
      type: "object",
      properties: { peer_id: { type: "string" }, query: { type: "string" } },
      required: ["peer_id", "query"],
    },
    showOutput: false,
    getDisplayInfo: () => ({ kind: "search" as const }),
    formatCall: (a) => `peer ${a.peer_id}: "${a.query}"`,
    async execute(args) {
      try {
        const results = await server.call(args.peer_id as string, "peer:context-search", args.query as string) as string;
        return { content: results || "(no matches)", exitCode: 0, isError: false };
      } catch (e) {
        return { content: `Failed to search peer context: ${e instanceof Error ? e.message : String(e)}`, exitCode: 1, isError: true };
      }
    },
    formatResult: (_a, r) => ({ summary: r.isError ? "failed" : `${r.content.split("\n").length} lines` }),
  });

  registerTool({
    name: "peer_send",
    description: "Send a text message to another peer. Appears in their UI and is queued for their next turn.",
    input_schema: {
      type: "object",
      properties: { peer_id: { type: "string" }, text: { type: "string" } },
      required: ["peer_id", "text"],
    },
    showOutput: false,
    getDisplayInfo: () => ({ kind: "write" as const }),
    formatCall: (a) => `peer ${a.peer_id}: "${String(a.text).slice(0, 40)}"`,
    async execute(args) {
      try {
        await server.call(args.peer_id as string, "peer:message", ctx.instanceId, args.text as string);
        return { content: `Sent to peer ${args.peer_id}.`, exitCode: 0, isError: false };
      } catch (e) {
        return { content: `Failed to send: ${e instanceof Error ? e.message : String(e)}`, exitCode: 1, isError: true };
      }
    },
    formatResult: (_a, r) => ({ summary: r.isError ? "failed" : "sent" }),
  });

  registerTool({
    name: "peer_inbox",
    description: "Read recent messages received from other peers via peer_send.",
    input_schema: {
      type: "object",
      properties: { count: { type: "number", description: "Max messages to return (default 20)." } },
      required: [],
    },
    showOutput: false,
    getDisplayInfo: () => ({ kind: "read" as const }),
    formatCall: () => "reading inbox",
    async execute(args) {
      const recent = inbox.slice(-((args.count as number) || 20));
      if (recent.length === 0) return { content: "(inbox empty)", exitCode: 0, isError: false };
      const lines = recent.map((e) => `[${Math.round((Date.now() - e.at) / 1000)}s ago] ${e.from}: ${e.text}`);
      return { content: lines.join("\n"), exitCode: 0, isError: false };
    },
    formatResult: (_a, r) => ({ summary: r.content === "(inbox empty)" ? "empty" : `${r.content.split("\n").length} msg` }),
  });

  registerTool({
    name: "peer_ask",
    description:
      "Ask another peer a question and wait synchronously for their answer. " +
      "Blocks for up to 2 minutes; the peer responds via peer_answer.",
    input_schema: {
      type: "object",
      properties: {
        peer_id: { type: "string" },
        question: { type: "string" },
      },
      required: ["peer_id", "question"],
    },
    showOutput: false,
    getDisplayInfo: () => ({ kind: "search" as const }),
    formatCall: (a) => `peer ${a.peer_id}: "${String(a.question).slice(0, 40)}"`,
    async execute(args) {
      try {
        const answer = await server.call(args.peer_id as string, "peer:ask", ctx.instanceId, args.question as string) as string;
        return { content: `Answer from peer ${args.peer_id}:\n\n${answer}`, exitCode: 0, isError: false };
      } catch (e) {
        return { content: `Ask failed: ${e instanceof Error ? e.message : String(e)}`, exitCode: 1, isError: true };
      }
    },
    formatResult: (_a, r) => ({ summary: r.isError ? "failed" : "answered" }),
  });

  registerTool({
    name: "peer_answer",
    description:
      "Resolve the oldest pending peer:ask question with this answer. " +
      "Use only when responding to a peer-asked question received this turn.",
    input_schema: {
      type: "object",
      properties: { answer: { type: "string" } },
      required: ["answer"],
    },
    showOutput: false,
    getDisplayInfo: () => ({ kind: "write" as const }),
    formatCall: (a) => `"${String(a.answer).slice(0, 40)}"`,
    async execute(args) {
      const slot = askQueue.shift();
      if (!slot) {
        return { content: "No pending peer:ask question to answer.", exitCode: 1, isError: true };
      }
      slot.resolve(args.answer as string);
      return { content: `Answered peer ${slot.from}.`, exitCode: 0, isError: false };
    },
    formatResult: (_a, r) => ({ summary: r.isError ? "no pending" : "answered" }),
  });

  // ── Slash command + system prompt + cwd sync ────────────────
  registerCommand("peers", "List running agent-sh peer instances", () => {
    const peers = server.discover();
    if (peers.length === 0) { bus.emit("ui:info", { message: "No peers found." }); return; }
    const lines = peers.map((p) => {
      const uptime = Math.round((Date.now() - p.startTime) / 1000);
      return `  ${p.id}  pid=${p.pid}  cwd=${p.cwd}  ${uptime}s`;
    });
    bus.emit("ui:info", { message: `Peers:\n${lines.join("\n")}` });
  });

  registerInstruction("Peer Mesh", [
    "You have access to a peer mesh — other running agent-sh instances on this machine.",
    "Use `peers` to discover them, then:",
    "- `peer_terminal` to see what's on another terminal's screen",
    "- `peer_terminal_send` to type keys into their PTY (use `\\r` for Enter)",
    "- `peer_history` to see recent commands they ran",
    "- `peer_search` to search their shell context",
    "- `peer_send` to deliver a one-way message",
    "- `peer_inbox` to read messages others sent you",
    "- `peer_ask` to ask a question and wait for their answer",
    "- `peer_answer` to respond when another peer has asked you a question this turn",
    "When the user references 'the other terminal' or 'my other shell', use these tools.",
  ].join("\n"));

  bus.on("shell:cwd-change", ({ cwd }) => server.updateCwd(cwd));
}
