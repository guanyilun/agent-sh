/** A run's control socket (config `control`): the overseer asks what is running and steers an agent by its label,
 *  with an answer at once ("queued for agent 7", "no running agent labelled X").
 *
 *  Narrow on purpose (2026-11-27).  The program and its agents share one sandbox, so the socket grants nothing an
 *  agent of the run cannot already do: `status` is what the state files show, `steer` is what a steer file does.
 *  No stop, no terminal, no other runs.  One JSON object per line each way:
 *    {"method": "status"}                          -> {"ok": true, "run", "agents": [{seq, label, state, minutes, tokens}], "tokens", "cached"}
 *    {"method": "steer", "label": L, "text": T}    -> {"ok": true, "queued": [seq, ...]} or {"ok": false, "error"}
 */
import * as fs from "node:fs";
import * as net from "node:net";

export interface LiveAgent {
  seq: number;
  label: string;
  state: "queued" | "working";
  since: number;
  tokens(): number;
  steer(text: string): void;
}

export interface ControlDeps {
  runId: string;
  agents(): LiveAgent[];
  totals(): { tokens: number; cached: number };
  log(line: string): void;
}

/** sun_path is 108 bytes on Linux and 104 on macOS, with the terminating NUL. */
export const MAX_SOCKET_PATH = 103;
const MAX_STEER_BYTES = 8192;

export function controlProblem(sockPath: string): string | undefined {
  const bytes = Buffer.byteLength(sockPath);
  if (bytes > MAX_SOCKET_PATH) return `config.control: the socket path is ${bytes} bytes and Unix sockets allow ${MAX_SOCKET_PATH}; use a shorter path`;
  try {
    if (!fs.lstatSync(sockPath).isSocket()) return `config.control: ${sockPath} exists and is not a socket`;
  } catch { /* free */ }
  return undefined;
}

export function answer(req: unknown, deps: ControlDeps): Record<string, unknown> {
  const r = (req && typeof req === "object" ? req : {}) as Record<string, unknown>;
  if (r.method === "status") {
    const now = Date.now();
    return {
      ok: true, run: deps.runId, ...deps.totals(),
      agents: deps.agents().map(a => ({ seq: a.seq, label: a.label, state: a.state, minutes: Math.round((now - a.since) / 6_000) / 10, tokens: a.tokens() })),
    };
  }
  if (r.method === "steer") {
    if (typeof r.label !== "string" || !r.label || typeof r.text !== "string" || !r.text.trim())
      return { ok: false, error: "steer needs a label and a non-empty text" };
    if (Buffer.byteLength(r.text) > MAX_STEER_BYTES) return { ok: false, error: `the text is over ${MAX_STEER_BYTES} bytes` };
    const running = deps.agents();
    const hits = running.filter(a => a.label === r.label);
    if (!hits.length) {
      const labels = [...new Set(running.map(a => a.label))];
      return { ok: false, error: `no running agent labelled ${r.label} (running: ${labels.join(", ") || "none"})` };
    }
    for (const a of hits) a.steer(r.text.trim());
    deps.log(`· control: steer for ${r.label} queued (agent ${hits.map(a => a.seq).join(", ")})`);
    return { ok: true, queued: hits.map(a => a.seq) };
  }
  return { ok: false, error: "unknown method: this socket offers status and steer" };
}

/** Listen on sockPath (mode 0600); returns the function that closes it and removes the socket file. */
export function startControl(sockPath: string, deps: ControlDeps): () => void {
  const problem = controlProblem(sockPath);
  if (problem) throw new Error(problem);
  try { fs.unlinkSync(sockPath); } catch { /* none left over */ }
  const server = net.createServer((conn) => {
    let buffer = "";
    conn.setEncoding("utf8");
    conn.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 4 * MAX_STEER_BYTES) { conn.destroy(); return; }
      for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 1);
        let reply: Record<string, unknown>;
        try { reply = answer(JSON.parse(line), deps); } catch { reply = { ok: false, error: "send one JSON object per line" }; }
        conn.write(`${JSON.stringify(reply)}\n`);
      }
    });
    conn.on("error", () => {});
    conn.setTimeout(30_000, () => conn.destroy());
  });
  server.on("error", (err) => deps.log(`· control socket error: ${err.message}`));
  const umask = process.umask(0o177);
  try { server.listen(sockPath); } finally { process.umask(umask); }
  server.on("listening", () => { try { fs.chmodSync(sockPath, 0o600); } catch { /* gone already */ } });
  server.unref();
  return () => {
    server.close();
    try { fs.unlinkSync(sockPath); } catch { /* removed */ }
  };
}
