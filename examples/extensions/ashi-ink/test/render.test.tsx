import test from "node:test";
import assert from "node:assert/strict";
import { render } from "ink-testing-library";
import { createInkRenderer, __renderNode, __harness } from "../src/ink-renderer.js";
import type { RenderModel } from "@guanyilun/ashi/render";
import type { RenderNode } from "@guanyilun/ashi/renderer";
import { ToolGroup } from "../../ashi/src/chat/tool-group.js";

const r = createInkRenderer();
const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

function frameOf(node: RenderNode): string {
  const { lastFrame } = render(__renderNode(node));
  return strip(lastFrame() ?? "");
}

test("renders ANSI text, markdown and a spacer inside a container", () => {
  const c = r.container();
  const t = r.text();
  t.setText("\x1b[38;2;128;128;128mhello from ink\x1b[39m");
  c.addChild(r.spacer(1));
  c.addChild(t.node);
  const md = r.markdown();
  md.setText("**bold** and `code`");
  c.addChild(md.node);

  const frame = frameOf(c.node);
  assert.match(frame, /hello from ink/);
  assert.match(frame, /bold/);
  assert.match(frame, /code/);
});

test("preserves ANSI styling (not stripped) in the rendered frame", () => {
  const t = r.text();
  t.setText("\x1b[1mBOLD\x1b[22m");
  const { lastFrame } = render(__renderNode(t.node));
  assert.match(lastFrame() ?? "", /\x1b\[1m/);
});

test("a sent user turn gets a background band, a reply does not", () => {
  const u = r.markdown({ osc133Zones: true });
  u.setText("hi");
  assert.match(render(__renderNode(u.node)).lastFrame() ?? "", /\x1b\[48;2;/);
  const a = r.markdown();
  a.setText("a reply");
  assert.doesNotMatch(render(__renderNode(a.node)).lastFrame() ?? "", /\x1b\[48;2;/);
});

const bashModel: RenderModel<{ command: string }> = {
  initial: ({ rawInput }) => ({ command: (rawInput as { command?: string })?.command ?? "" }),
  view: (s) => ({
    title: [{ text: "$ ", style: { bold: true } }, { text: s.command, highlight: "bash" }],
    status: s.status,
    body: { kind: "stream", text: s.output },
    expandable: true,
  }),
};

test("the app shell renders scrollback content, input and status together", () => {
  const h = __harness();
  const line = h.nodes.text();
  line.setText("a chat line");
  h.app.scrollback.addChild(line.node);
  h.app.status.setRenderFn(() => ["model@provider  10k tokens"]);
  const { lastFrame } = render(h.element);
  const frame = strip(lastFrame() ?? "");
  assert.match(frame, /a chat line/);
  assert.match(frame, /model@provider/);
  // Ink's flat prompt.
  assert.match(frame, /❯/);
});

test("mounts a tool call + result through the renderer", () => {
  const env = { width: 80, mode: "preview" as const, previewLines: 5 };
  const args = { toolCallId: "t1", name: "bash", title: "bash", rawInput: { command: "ls -la" } };

  const call = r.mountToolCall(bashModel as RenderModel<unknown>, args, env);
  assert.match(frameOf(call.node), /\$ ls -la/);

  const result = r.mountToolResult(bashModel as RenderModel<unknown>, args, env);
  result.appendChunk("file1\nfile2\n");
  result.finalize({ exitCode: 0 });
  const f = frameOf(result.node);
  assert.match(f, /file1/);
  assert.match(f, /file2/);
  // Output is channeled by Ink's magenta gutter bar, not a corner-arrow.
  assert.match(f, /▌ file1/);
  // call line picks up the ✓ from the shared cell after finalize
  assert.match(frameOf(call.node), /▌ .*\$ ls -la\s+✓/);
});

test("a tool group is drawn with the gutter, not pi-tui's tree connectors", () => {
  const g = new ToolGroup(r as never, "read");
  g.addCall("1", "read_file", "src/app.ts");
  g.addCall("2", "ls", "src/");
  g.recordCompletion("1", 0, "120 lines");
  const frame = frameOf(g.node);
  assert.match(frame, /▌ ◆ read/);
  assert.match(frame, /▌ {3}src\/app\.ts.*✓ 120 lines/);
  assert.match(frame, /ls src\//); // child name shown when it differs from the kind
  assert.doesNotMatch(frame, /[├└]/);
});

test("a wide markdown table is fit to the width and wraps cell content", () => {
  const desc = Object.getOwnPropertyDescriptor(process.stdout, "columns");
  Object.defineProperty(process.stdout, "columns", { value: 70, configurable: true });
  try {
    const md = r.markdown({ paddingX: 1 });
    md.setText("| Col | What it does |\n|---|---|\n| a | " + "lorem ".repeat(30).trim() + " |");
    const frame = frameOf(md.node);
    const maxW = Math.max(...frame.split("\n").map((l) => l.length));
    assert.ok(maxW <= 70, `table should fit 70 cols, got ${maxW}`);
    assert.match(frame, /[┌┬┐]/); // a real box-drawn table, not scrambled
    const bodyRows = frame.split("\n").filter((l) => l.includes("│")).length;
    assert.ok(bodyRows > 3, `the long cell should wrap across rows, got ${bodyRows}`);
  } finally {
    if (desc) Object.defineProperty(process.stdout, "columns", desc);
    else delete (process.stdout as { columns?: number }).columns;
  }
});
