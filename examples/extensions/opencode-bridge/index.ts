/**
 * opencode bridge — runs opencode in-process as agent-sh's backend via
 * @opencode-ai/sdk. The SDK boots an embedded HTTP server we talk to with
 * a generated client; events stream over a single global SSE channel.
 *
 * Requires opencode authenticated locally (`opencode auth login`).
 */
import { createOpencode, type OpencodeClient, type Event, type Part, type ToolPart } from "@opencode-ai/sdk";
import type { ExtensionContext } from "agent-sh/types";
import { computeDiff, type DiffResult } from "agent-sh/utils/diff";

function parseUnifiedDiff(patch: string): DiffResult | null {
  if (!patch) return null;
  const hunks: DiffResult["hunks"] = [];
  let current: DiffResult["hunks"][number] | null = null;
  let oldNo = 0;
  let newNo = 0;
  let added = 0;
  let removed = 0;

  for (const raw of patch.split("\n")) {
    if (raw.startsWith("Index:") || raw.startsWith("===") || raw.startsWith("--- ") || raw.startsWith("+++ ")) continue;
    const hunkHeader = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkHeader) {
      if (current) hunks.push(current);
      current = { lines: [] };
      oldNo = parseInt(hunkHeader[1]!, 10);
      newNo = parseInt(hunkHeader[2]!, 10);
      continue;
    }
    if (!current) continue;
    if (raw.startsWith("+")) {
      current.lines.push({ type: "added", oldNo: null, newNo, text: raw.slice(1) });
      newNo++;
      added++;
    } else if (raw.startsWith("-")) {
      current.lines.push({ type: "removed", oldNo, newNo: null, text: raw.slice(1) });
      oldNo++;
      removed++;
    } else if (raw.startsWith(" ")) {
      current.lines.push({ type: "context", oldNo, newNo, text: raw.slice(1) });
      oldNo++;
      newNo++;
    }
  }
  if (current) hunks.push(current);
  if (hunks.length === 0) return null;
  return { hunks, added, removed, isIdentical: added + removed === 0, isNewFile: false };
}

export default function activate(ctx: ExtensionContext): void {
  const { bus, call } = ctx;

  const cwd = (): string => {
    const v = call("cwd");
    return typeof v === "string" && v ? v : process.cwd();
  };

  let runtime: { client: OpencodeClient; server: { url: string; close(): void } } | null = null;
  let sessionId: string | null = null;
  // opencode treats `directory` as the project ID and routes its SSE event
  // stream per-project. If we let prompts use the user's PTY cwd freely,
  // an in-shell `cd` switches opencode's project mid-session and our SSE
  // (opened on the original project) goes silent — including for tool
  // events. Pin everything to the directory captured at session.create;
  // the agent still learns the user's real cwd via <shell_events> and
  // can operate elsewhere through absolute paths or `cd && cmd` in Bash.
  let sessionDirectory: string | null = null;
  let serverAbort: AbortController | null = null;
  let streamAbort: AbortController | null = null;
  let booting = true;

  const announcedTools = new Set<string>();
  const completedTools = new Set<string>();
  // message.part.delta only carries `field` ("text"), not the part's
  // type. Cache type from message.part.updated to route deltas correctly
  // (text → response, reasoning → thinking).
  const partKinds = new Map<string, string>();
  let turnText = "";

  // prompt() and SSE deltas race; resolve the turn on session.idle.
  let pendingTurnEnd: (() => void) | null = null;
  let turnIdleSeen = false;
  let turnError: string | null = null;

  const listeners: Array<{ event: string; fn: Function }> = [];

  function toolKind(name: string): string {
    const n = name.toLowerCase();
    if (n === "read") return "read";
    if (n === "edit" || n === "patch") return "edit";
    if (n === "write") return "write";
    if (n === "glob" || n === "grep" || n === "list") return "search";
    if (n === "bash" || n === "shell") return "execute";
    return "execute";
  }

  function formatToolCall(name: string, input: Record<string, unknown>): string {
    const str = (v: unknown) => typeof v === "string" ? v : "";
    const n = name.toLowerCase();
    if (n === "bash" || n === "shell") return `$ ${str(input.command)}`;
    if (n === "read" || n === "edit" || n === "write") return str(input.filePath ?? input.file_path ?? input.path);
    if (n === "grep" || n === "glob") return `${str(input.pattern)} ${str(input.path)}`.trim();
    return name;
  }

  function toolLocations(input: Record<string, unknown>): { path: string; line?: number | null }[] | undefined {
    const raw = input.filePath ?? input.file_path ?? input.path;
    if (typeof raw !== "string") return undefined;
    const line = (input.line_number ?? input.line ?? input.offset) as number | undefined;
    return [{ path: raw, line: line ?? null }];
  }

  function handleToolPart(part: ToolPart): void {
    const { callID, tool: toolName, state } = part;
    const kind = toolKind(toolName);

    if (state.status !== "pending" && !announcedTools.has(callID)) {
      announcedTools.add(callID);
      bus.emit("agent:tool-started", {
        title: toolName,
        toolCallId: callID,
        kind,
        locations: toolLocations(state.input ?? {}),
        rawInput: state.input,
        displayDetail: formatToolCall(toolName, state.input ?? {}),
      });
    }

    if ((state.status === "completed" || state.status === "error") && !completedTools.has(callID)) {
      completedTools.add(callID);
      const isError = state.status === "error";
      const rawOutput = isError ? state.error : state.output;

      let resultDisplay: { summary?: string; body?: { kind: "diff"; diff: DiffResult; filePath: string } } | undefined;
      if (!isError && state.status === "completed") {
        const filePath = state.input?.filePath as string | undefined;
        let diff: DiffResult | null = null;
        if (toolName === "edit") {
          const patch = (state.metadata as any)?.filediff?.patch as string | undefined;
          if (patch) diff = parseUnifiedDiff(patch);
        } else if (toolName === "write") {
          // Overwrites of existing files render as new-file diffs —
          // opencode doesn't surface old content.
          const content = state.input?.content as string | undefined;
          if (typeof content === "string") diff = computeDiff(null, content);
        }
        if (diff && filePath && !diff.isIdentical) {
          const summary = diff.isNewFile
            ? `+${diff.added}`
            : `+${diff.added} -${diff.removed}`;
          resultDisplay = {
            summary,
            body: { kind: "diff", diff, filePath },
          };
        }
      }

      bus.emitTransform("agent:tool-completed", {
        toolCallId: callID,
        exitCode: isError ? 1 : 0,
        rawOutput,
        kind,
        resultDisplay,
      });
      bus.emit("agent:tool-output", {
        tool: toolName,
        output: typeof rawOutput === "string" ? rawOutput : "",
        exitCode: isError ? 1 : 0,
      });
    }
  }

  function emitTextDelta(text: string): void {
    bus.emitTransform("agent:response-chunk", {
      blocks: [{ type: "text" as const, text }],
    });
    turnText += text;
  }

  function handleEvent(event: Event): void {
    if (!sessionId) return;
    const evType = (event as any).type as string;
    const props = (event as any).properties ?? {};
    const sid = props.sessionID;
    if (typeof sid === "string" && sid !== sessionId) return;

    switch (evType) {
      // message.part.delta is undocumented in the SDK's Event union but
      // the SSE consumer yields it. Drop chunks for unknown partIDs —
      // misrouting bleeds reasoning into the response or vice versa.
      case "message.part.delta": {
        if (typeof props.delta !== "string" || !props.delta) break;
        const kind = partKinds.get(props.partID);
        if (kind === "reasoning") bus.emit("agent:thinking-chunk", { text: props.delta });
        else if (kind === "text") emitTextDelta(props.delta);
        break;
      }
      case "message.part.updated": {
        const part = props.part as Part | undefined;
        if (!part) break;
        partKinds.set(part.id, part.type);
        if (part.type === "tool") handleToolPart(part);
        break;
      }
      case "session.idle": {
        turnIdleSeen = true;
        pendingTurnEnd?.();
        break;
      }
      case "session.error": {
        const err = props.error as { message?: string } | undefined;
        const message = err?.message ?? "opencode session error";
        // session.prompt() does not always reject on session error;
        // drive turn-end ourselves and abort to unstick a hanging prompt().
        turnError = message;
        bus.emit("agent:error", { message });
        turnIdleSeen = true;
        pendingTurnEnd?.();
        if (runtime && sessionId) {
          runtime.client.session
            .abort({ path: { id: sessionId }, query: sessionDirectory ? { directory: sessionDirectory } : undefined })
            .catch(() => { /* abort is best-effort */ });
        }
        break;
      }
      // Without a reply the gated tool hangs forever. The bridge has no
      // interactive approval UI, so auto-approve — mirrors claude-code-
      // bridge's permissionMode: "acceptEdits". Set permission.edit:
      // "allow" in opencode.json to skip the round-trip entirely.
      case "permission.asked":
      case "permission.updated": {
        const permissionID = props.id as string | undefined;
        if (!permissionID || !runtime || !sessionId) break;
        runtime.client
          .postSessionIdPermissionsPermissionId({
            path: { id: sessionId, permissionID },
            query: sessionDirectory ? { directory: sessionDirectory } : undefined,
            body: { response: "once" },
          })
          .catch(() => { /* approval is best-effort */ });
        break;
      }
    }
  }

  async function consumeEvents(client: OpencodeClient, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        const result = await client.event.subscribe({ signal });
        for await (const ev of result.stream) {
          if (signal.aborted) return;
          handleEvent(ev as Event);
        }
      } catch {
        if (signal.aborted) return;
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }

  const wireListeners = () => {
    const onSubmit = async ({ query: userQuery }: { query: string }) => {
      if (!runtime || !sessionId) {
        bus.emit("agent:error", {
          message: booting ? "opencode is still starting up..." : "opencode session not initialized",
        });
        bus.emit("agent:processing-done", {});
        return;
      }

      bus.emit("agent:query", { query: userQuery });
      bus.emit("agent:processing-start", {});
      turnText = "";
      turnIdleSeen = false;
      turnError = null;
      // Set the idle waiter BEFORE prompt() so a fast session.idle can't
      // race in before we're listening.
      const idlePromise = new Promise<void>((resolve) => {
        pendingTurnEnd = () => { resolve(); pendingTurnEnd = null; };
      });

      const ctxText = String(call("query-context:build") ?? "").trim();
      const finalPrompt = ctxText ? `${ctxText}\n\n${userQuery}` : userQuery;

      try {
        const res = await runtime.client.session.prompt({
          path: { id: sessionId },
          query: sessionDirectory ? { directory: sessionDirectory } : undefined,
          body: {
            parts: [{ type: "text", text: finalPrompt }],
          },
        });
        if (!turnIdleSeen) {
          await Promise.race([
            idlePromise,
            new Promise<void>((r) => setTimeout(r, 60_000)),
          ]);
        }
        if (turnError) {
          bus.emitTransform("agent:response-done", { response: "" });
        } else {
          // Fallback if SSE never delivered text (network blip, missed
          // partKinds entry); the prompt response always carries the final.
          if (!turnText && res.data?.parts) {
            for (const p of res.data.parts) {
              if (p.type === "text" && p.text) turnText += p.text;
            }
            if (turnText) {
              bus.emitTransform("agent:response-chunk", {
                blocks: [{ type: "text" as const, text: turnText }],
              });
            }
          }
          bus.emitTransform("agent:response-done", { response: turnText });
        }
      } catch (err) {
        if (!turnError) {
          bus.emit("agent:error", {
            message: err instanceof Error ? err.message : String(err),
          });
        }
      } finally {
        pendingTurnEnd = null;
        bus.emit("agent:processing-done", {});
      }
    };

    const onCancel = async () => {
      if (!runtime || !sessionId) return;
      try {
        await runtime.client.session.abort({ path: { id: sessionId } });
      } catch { /* abort is best-effort */ }
    };

    const onReset = async () => {
      if (!runtime) return;
      announcedTools.clear();
      completedTools.clear();
      partKinds.clear();
      // /reset is the one moment we deliberately let the project switch.
      sessionDirectory = cwd();
      const res = await runtime.client.session.create({ query: { directory: sessionDirectory } });
      sessionId = res.data?.id ?? null;
    };

    bus.on("agent:submit", onSubmit);
    bus.on("agent:cancel-request", onCancel);
    bus.on("agent:reset-session", onReset);
    listeners.push(
      { event: "agent:submit", fn: onSubmit },
      { event: "agent:cancel-request", fn: onCancel },
      { event: "agent:reset-session", fn: onReset },
    );
  };

  const unwireListeners = () => {
    for (const { event, fn } of listeners) bus.off(event as any, fn as any);
    listeners.length = 0;
  };

  bus.emit("agent:register-backend", {
    name: "opencode",
    start: async () => {
      try {
        serverAbort = new AbortController();
        runtime = await createOpencode({ signal: serverAbort.signal });

        streamAbort = new AbortController();
        // Subscribe before creating the session so we don't miss early events.
        void consumeEvents(runtime.client, streamAbort.signal);

        sessionDirectory = cwd();
        const res = await runtime.client.session.create({ query: { directory: sessionDirectory } });
        sessionId = res.data?.id ?? null;
        if (!sessionId) throw new Error("session.create returned no id");

        wireListeners();
        booting = false;
        bus.emit("agent:info", { name: "opencode", version: "1.x" });
      } catch (err) {
        booting = false;
        bus.emit("ui:error", {
          message: `opencode-bridge: failed to initialize — ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    },
    kill: () => {
      unwireListeners();
      streamAbort?.abort();
      serverAbort?.abort();
      runtime?.server.close();
      runtime = null;
      sessionId = null;
      sessionDirectory = null;
      announcedTools.clear();
      completedTools.clear();
      partKinds.clear();
      booting = true;
    },
  });
}
