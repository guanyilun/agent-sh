import test from "node:test";
import assert from "node:assert/strict";
import { createPiTuiRenderer } from "../src/renderers/pi-tui/index.js";
import { InfoLine, ErrorLine } from "../src/chat/lines.js";
import { AssistantMessage } from "../src/chat/assistant.js";
import { ThinkingBlock } from "../src/chat/thinking.js";
import { ToolGroup } from "../src/chat/tool-group.js";
import { registerDefaultSchemaRenderers } from "../src/default-schema-renderers.js";
import type { RenderNode, Renderer } from "../src/renderer.js";
import type { ExtensionContext } from "agent-sh/types";
import type { RenderModel } from "../src/schema.js";

// createPiTuiRenderer builds the content-node factories without mounting an app,
// so these run headless. Render a node and strip styling to assert on text.
const renderer: Renderer = createPiTuiRenderer();

function lines(node: RenderNode, width = 80): string[] {
  const comp = node as unknown as { render(w: number): string[] };
  return comp
    .render(width)
    .map((l) =>
      l
        .replace(/\x1b\[[0-9;]*m/g, "")
        .replace(/\x1b\]133;[A-C]\x07/g, "")
        .replace(/\s+$/, ""),
    );
}

test("InfoLine / ErrorLine render padded single lines", () => {
  assert.deepEqual(lines(new InfoLine(renderer, "hello").node), [" hello"]);
  assert.deepEqual(lines(new ErrorLine(renderer, "boom").node), [" ✗ boom"]);
});

test("AssistantMessage streams text and renders markdown", () => {
  const am = new AssistantMessage(renderer);
  am.appendText("Hello ");
  am.appendText("**world**");
  assert.equal(am.hasContent(), true);
  am.finalize();
  assert.deepEqual(lines(am.node), ["", " Hello world"]);
});

test("AssistantMessage hasContent is false before any text", () => {
  const am = new AssistantMessage(renderer);
  assert.equal(am.hasContent(), false);
});

test("ThinkingBlock hides and restores its buffer", () => {
  const tb = new ThinkingBlock(renderer);
  tb.appendText("pondering");
  tb.finalize();
  assert.deepEqual(lines(tb.node), ["", " pondering"]);
  tb.setHidden(true);
  assert.deepEqual(lines(tb.node), []);
  tb.setHidden(false);
  assert.deepEqual(lines(tb.node), ["", " pondering"]);
});

test("ToolGroup renders header, connectors and completion marks", () => {
  const g = new ToolGroup(renderer, "read", Infinity);
  g.addCall("1", "read_file", "a.ts");
  g.addCall("2", "read_file", "b.ts");
  g.recordCompletion("1", 0, "10 lines");
  const out = lines(g.node);
  assert.equal(out[0], "");
  assert.equal(out[1], " ◆ read");
  assert.equal(out[2], " ├ a.ts  ✓ 10 lines");
  assert.equal(out[3], " └ b.ts  …");
});

function bashModel(): RenderModel<unknown> {
  const handlers = new Map<string, (a: unknown) => unknown>();
  const ctx = {
    define: (n: string, f: (a: unknown) => unknown) => handlers.set(n, f),
    call: (n: string, a?: unknown) => handlers.get(n)?.(a),
    list: () => [...handlers.keys()],
  } as unknown as ExtensionContext;
  registerDefaultSchemaRenderers(ctx);
  return ctx.call("ashi:render-tool:bash") as RenderModel<unknown>;
}

test("schema tool call/result mount and render through the renderer", () => {
  const model = bashModel();
  const env = { width: 80, mode: "preview" as const, previewLines: 5 };
  const args = { toolCallId: "t1", name: "bash", title: "bash", rawInput: { command: "ls -la" } };

  const call = renderer.mountToolCall(model, args, env);
  // Leading spacer line, then the call title with a pending marker.
  assert.deepEqual(lines(call.node), ["", " $ ls -la  …"]);

  const result = renderer.mountToolResult(model, args, env);
  result.appendChunk("file1\nfile2\n");
  result.finalize({ exitCode: 0 });
  // call line picks up the ✓ from the shared cell once the result finalizes.
  assert.match(lines(call.node)[1]!, /\$ ls -la\s+✓/);
  assert.deepEqual(lines(result.node), [" └ file1", "   file2"]);
});

test("expanded stream output is tail-capped, not dumped in full", () => {
  const model = bashModel();
  const env = { width: 200, mode: "preview" as const, previewLines: 5 };
  const args = { toolCallId: "big", name: "bash", title: "bash", rawInput: { command: "yes" } };
  const result = renderer.mountToolResult(model, args, env);
  result.appendChunk(Array.from({ length: 600 }, (_, i) => `line ${i + 1}`).join("\n"));
  result.finalize({ exitCode: 0 });
  result.toggleExpanded();

  const out = lines(result.node);
  assert.ok(out.some((l) => /600 total/.test(l)), "shows the hidden-lines note");
  assert.ok(out.some((l) => /\bline 600\b/.test(l)), "shows the tail");
  assert.ok(!out.some((l) => /\bline 1\b/.test(l)), "drops the earliest lines");
  assert.ok(out.length < 600, "does not render all 600 lines");
});
