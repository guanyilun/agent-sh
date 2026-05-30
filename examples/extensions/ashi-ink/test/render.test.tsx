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

test("user ❯ marker starts at column 0; assistant gets a ⏺ bullet", () => {
  const u = r.markdown({ osc133Zones: true });
  u.setText("hello");
  const uf = strip(render(__renderNode(u.node)).lastFrame() ?? "");
  assert.match(uf, /^❯ hello/m); // ❯ at column 0, single-space gutter
  const a = r.markdown({ bullet: true });
  a.setText("a reply");
  const af = strip(render(__renderNode(a.node)).lastFrame() ?? "");
  assert.match(af, /^⏺ a reply/m);
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

test("streaming markdown (stable-prefix) converges to the one-shot render", () => {
  const desc = Object.getOwnPropertyDescriptor(process.stdout, "columns");
  Object.defineProperty(process.stdout, "columns", { value: 70, configurable: true });
  try {
    const doc =
      "# Title\n\nFirst paragraph long enough to wrap across the width a little bit.\n\n" +
      "- item one\n- item two\n\n```js\nconst x = 1;\n```\n\nClosing words here.";
    const streamed = r.markdown({ paddingX: 1 });
    for (let i = 1; i < doc.length; i += 5) { streamed.setText(doc.slice(0, i)); frameOf(streamed.node); }
    streamed.setText(doc);
    const streamedFrame = frameOf(streamed.node);
    const oneShot = r.markdown({ paddingX: 1 });
    oneShot.setText(doc);
    assert.equal(streamedFrame, frameOf(oneShot.node));
    assert.match(streamedFrame, /Title/);
    assert.match(streamedFrame, /Closing words/);
  } finally {
    if (desc) Object.defineProperty(process.stdout, "columns", desc);
    else delete (process.stdout as { columns?: number }).columns;
  }
});

test("committed scrollback renders via <Static>, alongside the live tail", () => {
  const h = __harness();
  const a = h.nodes.text(); a.setText("first turn");
  const b = h.nodes.text(); b.setText("second turn");
  h.app.scrollback.addChild(a.node);
  h.app.scrollback.addChild(b.node);
  h.app.commitScrollback?.(); // both settle into the <Static> region
  const c = h.nodes.text(); c.setText("live tail");
  h.app.scrollback.addChild(c.node);
  const frame = strip(render(h.element).lastFrame() ?? "");
  assert.match(frame, /first turn/);
  assert.match(frame, /second turn/);
  assert.match(frame, /live tail/);
});

test("the renderer puts a blank line between top-level blocks", () => {
  const h = __harness();
  const a = h.nodes.text(); a.setText("block one");
  const b = h.nodes.text(); b.setText("block two");
  h.app.scrollback.addChild(a.node);
  h.app.scrollback.addChild(b.node);
  const frame = strip(render(h.element).lastFrame() ?? "");
  // one blank line above the second block (the first, at index 0, gets none)
  assert.match(frame, /block one *\n *\nblock two/);
});

test("a block's leading substrate spacer doesn't double the inter-block gap", () => {
  const h = __harness();
  const mk = (t: string): RenderNode => {
    const c = h.nodes.container();
    c.addChild(h.nodes.spacer(1)); // pi-tui's per-block gap; ink owns rhythm instead
    const tx = h.nodes.text(); tx.setText(t);
    c.addChild(tx.node);
    return c.node;
  };
  h.app.scrollback.addChild(mk("alpha"));
  h.app.scrollback.addChild(mk("beta"));
  const frame = strip(render(h.element).lastFrame() ?? "");
  assert.match(frame, /alpha *\n *\nbeta/); // exactly one blank between
  assert.doesNotMatch(frame, /alpha *\n *\n *\nbeta/); // not two
});

test("a tool result stays tight under its call (no inter-block gap)", () => {
  const env = { width: 80, mode: "preview" as const, previewLines: 5 };
  const args = { toolCallId: "tt", name: "bash", title: "bash", rawInput: { command: "echo hi" } };
  const call = r.mountToolCall(bashModel as RenderModel<unknown>, args, env);
  const result = r.mountToolResult(bashModel as RenderModel<unknown>, args, env);
  result.appendChunk("hi\n");
  result.finalize({ exitCode: 0 });
  const h = __harness();
  h.app.scrollback.addChild(call.node);
  h.app.scrollback.addChild(result.node);
  const frame = strip(render(h.element).lastFrame() ?? "");
  // the ⎿ result is the line immediately under the ⏺ call — no blank line between
  assert.match(frame, /⏺ Bash\(echo hi\) *\n *⎿  hi/);
});

test("mounts a tool call + result through the renderer", () => {
  const env = { width: 80, mode: "preview" as const, previewLines: 5 };
  const args = { toolCallId: "t1", name: "bash", title: "bash", rawInput: { command: "ls -la" } };

  const call = r.mountToolCall(bashModel as RenderModel<unknown>, args, env);
  // Claude Code look: ⏺ Name(detail), no schema icon / $ prefix.
  assert.match(frameOf(call.node), /⏺ Bash\(ls -la\)/);

  const result = r.mountToolResult(bashModel as RenderModel<unknown>, args, env);
  result.appendChunk("file1\nfile2\n");
  result.finalize({ exitCode: 0 });
  const f = frameOf(result.node);
  assert.match(f, /file1/);
  assert.match(f, /file2/);
  // Output hangs under a ⎿ gutter, not a └ corner-arrow.
  assert.match(f, /⎿  file1/);
  assert.doesNotMatch(f, /└/);
  // call line keeps the ⏺ header after finalize (status is the bullet's color).
  assert.match(frameOf(call.node), /⏺ Bash\(ls -la\)/);
});

test("a read group: gerund + in-flight path while active, count when done, full list on expand", () => {
  const g = new ToolGroup(r as never, "read");
  g.addCall("1", "read_file", "src/app.ts");
  g.addCall("2", "read_file", "src/util.ts");
  g.recordCompletion("1", 0, "120 lines");
  // call 2 still running → active: gerund, ellipsis, ctrl+o hint, in-flight path shown
  let collapsed = frameOf(g.node);
  assert.match(collapsed, /⏺ Reading 2 files…/);
  assert.match(collapsed, /\(ctrl\+o to expand\)/);
  assert.match(collapsed, /⎿  src\/util\.ts/); // the file being read, not just a count
  assert.doesNotMatch(collapsed, /[├└]/);
  // finish it → past tense, no path under the collapsed summary
  g.recordCompletion("2", 0, "45 lines");
  collapsed = frameOf(g.node);
  assert.match(collapsed, /⏺ Read 2 files/);
  assert.doesNotMatch(collapsed, /⎿/);
  // expand → full list with per-file summaries, no hint
  g.toggleExpanded();
  const expanded = frameOf(g.node);
  assert.match(expanded, /⎿  src\/app\.ts.*120 lines/);
  assert.match(expanded, /⎿  src\/util\.ts.*45 lines/);
  assert.doesNotMatch(expanded, /\(ctrl\+o to expand\)/);
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

test("a small table grows to its content, not the full terminal width", () => {
  const desc = Object.getOwnPropertyDescriptor(process.stdout, "columns");
  Object.defineProperty(process.stdout, "columns", { value: 70, configurable: true });
  try {
    const md = r.markdown({ paddingX: 1 });
    md.setText("| A | B |\n|---|---|\n| x | y |");
    const frame = frameOf(md.node);
    const maxW = Math.max(...frame.split("\n").map((l) => l.length));
    assert.match(frame, /[┌┬┐]/);
    assert.ok(maxW < 30, `small table should grow to content, got width ${maxW}`);
  } finally {
    if (desc) Object.defineProperty(process.stdout, "columns", desc);
    else delete (process.stdout as { columns?: number }).columns;
  }
});
