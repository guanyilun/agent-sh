import test from "node:test";
import assert from "node:assert/strict";
import { render } from "ink-testing-library";
import { createInkRenderer, __renderNode, __harness } from "../src/ink-renderer.js";
import type { RenderModel } from "@guanyilun/ashi/render";
import type { RenderNode } from "@guanyilun/ashi/renderer";
import { ToolGroup } from "../../ashi/src/chat/tool-group.js";
import { ThinkingBlock } from "../../ashi/src/chat/thinking.js";
import { createAutocompleteController } from "../../ashi/src/autocomplete-controller.js";
import type { AutocompleteProvider } from "@guanyilun/ashi/renderer";

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

test("a long list item wraps with a hanging indent, not back to column 0", () => {
  const desc = Object.getOwnPropertyDescriptor(process.stdout, "columns");
  Object.defineProperty(process.stdout, "columns", { value: 40, configurable: true });
  try {
    const md = r.markdown();
    md.setText("- this is a fairly long list item that should wrap across the width here");
    const lines = frameOf(md.node).split("\n").filter((l) => l.trim());
    assert.ok(lines.length >= 2, `expected the item to wrap, got ${lines.length} line(s)`);
    assert.match(lines[0], /^\* this is/); // bullet at column 0
    assert.match(lines[1], /^ {2}\S/); // continuation hangs under the bullet text, not col 0
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

test("multi-line tool output is consistently colored (not first-line-only)", () => {
  const env = { width: 80, mode: "preview" as const, previewLines: 10 };
  const args = { toolCallId: "m1", name: "bash", title: "bash", rawInput: { command: "ls" } };
  const result = r.mountToolResult(bashModel as RenderModel<unknown>, args, env);
  result.appendChunk("alpha\nbravo\ncharlie\n");
  result.finalize({ exitCode: 0 });
  const raw = render(__renderNode(result.node)).lastFrame() ?? "";
  const out = raw.split("\n").filter((l) => /alpha|bravo|charlie/.test(l));
  assert.equal(out.length, 3);
  // every output row carries a color code — Ink drops a block-spanning SGR at each
  // newline, so without per-line re-emission only the first row would be styled.
  for (const l of out) assert.match(l, /\x1b\[38;2;/);
});

test("a read group: tail pinned + flashing while open, summary-only once sealed, full list on expand", () => {
  const g = new ToolGroup(r as never, "read");
  g.addCall("1", "read_file", "src/app.ts");
  g.addCall("2", "read_file", "src/util.ts");
  g.recordCompletion("1", 0, "120 lines");
  let collapsed = frameOf(g.node);
  assert.match(collapsed, /⏺ Reading 2 files…/);
  assert.match(collapsed, /\(ctrl\+o to expand\)/);
  assert.match(collapsed, /⎿  src\/util\.ts/);
  assert.doesNotMatch(collapsed, /[├└]/);
  g.recordCompletion("2", 0, "45 lines");
  collapsed = frameOf(g.node);
  assert.match(collapsed, /⏺ Reading 2 files…/);
  assert.match(collapsed, /⎿  src\/util\.ts/);
  g.seal();
  collapsed = frameOf(g.node);
  assert.match(collapsed, /⏺ Read 2 files/);
  assert.doesNotMatch(collapsed, /⎿/);
  g.toggleExpanded();
  const expanded = frameOf(g.node);
  assert.match(expanded, /⎿  src\/app\.ts.*120 lines/);
  assert.match(expanded, /⎿  src\/util\.ts.*45 lines/);
  assert.doesNotMatch(expanded, /\(ctrl\+o to expand\)/);
});

test("revealed thinking is dim-tinted and survives marked's resets", () => {
  const tb = new ThinkingBlock(r as never);
  tb.appendText("Let me think about this plainly.");
  const frame = render(__renderNode(tb.node)).lastFrame() ?? "";
  assert.match(strip(frame), /Let me think about this plainly\./);
  assert.match(frame, /\x1b\[38;2;128;128;128m[^\x1b]/);
  assert.match(frame, /\x1b\[2m/);
});

test("the thinking loader is coral and shows a per-turn elapsed timer", () => {
  const h = __harness();
  const loader = h.app.createLoader("thinking…", (t) => t, (t) => t);
  const inst = render(__renderNode(loader.node));
  const frame = inst.lastFrame() ?? "";
  inst.unmount();
  loader.stop();
  assert.match(frame, /38;2;217;119;87m/); // coral accent
  assert.match(frame, /thinking… \(\d+s\)/);
});

test("a diff result hangs under the ⎿ gutter with no box frame (flush gutter)", () => {
  const env = { width: 80, mode: "preview" as const, previewLines: 50 };
  const args = { toolCallId: "d1", name: "edit_file", title: "edit", displayDetail: "src/app.ts", rawInput: {} };
  const diffModel: RenderModel<Record<string, never>> = {
    initial: () => ({}),
    view: (s) => ({
      title: [{ text: "Edit", style: { bold: true } }],
      status: s.status,
      body: s.hasDiff ? { kind: "diff" } : undefined,
      expandable: true,
    }),
  };
  const result = r.mountToolResult(diffModel as RenderModel<unknown>, args, env);
  result.setDiffRenderer(() => ["1  const x = 1", "2 -const y = 2", "2 +const y = 3"]);
  result.finalize({ exitCode: 0 });
  const f = frameOf(result.node);
  assert.match(f, /⎿  1  const x = 1/); // first hunk line under the gutter
  assert.match(f, /2 -const y = 2/);
  assert.match(f, /2 \+const y = 3/);
  assert.doesNotMatch(f, /[╭╰╮╯┌┐└┘]/); // no box frame corners
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

test("typed text lands in the editor and shows in the input box", () => {
  const h = __harness();
  h.feedInput("hello");
  assert.equal(h.editor.text, "hello");
  const frame = strip(render(h.element).lastFrame() ?? "");
  assert.match(frame, /❯ hello/);
});

test("Alt+B moves back one word (readline word navigation)", () => {
  const h = __harness();
  h.feedInput("foo bar");
  h.feedInput("\x1bb"); // Alt+B
  h.feedInput("X");
  assert.equal(h.editor.text, "foo Xbar");
});

test("Shift+Enter inserts a newline; Enter submits", () => {
  const h = __harness();
  let submitted: string | null = null;
  h.app.input.onSubmit((t) => { submitted = t; h.app.input.setText(""); });
  h.feedInput("ab");
  h.feedInput("\x1b[13;2u"); // kitty Shift+Enter
  h.feedInput("cd");
  assert.equal(h.editor.text, "ab\ncd");
  h.feedInput("\r"); // Enter
  assert.equal(submitted, "ab\ncd");
  assert.equal(h.editor.text, ""); // onSubmit cleared it
});

test("the input box border color follows setBorderColor (shell mode)", () => {
  const h = __harness();
  const before = render(h.element).lastFrame() ?? "";
  assert.doesNotMatch(before, /38;2;220;180;0/); // default gray, not yellow
  h.app.input.setBorderColor((t) => `\x1b[38;2;220;180;0m${t}\x1b[39m`); // a theme.fg-style yellow styler
  const after = render(h.element).lastFrame() ?? "";
  assert.match(after, /38;2;220;180;0/); // border now carries the shell-mode color
});

test("the input box border uses the same gray as the ❯ marker", () => {
  const h = __harness();
  const raw = render(h.element).lastFrame() ?? "";
  // MARKER_GRAY_HEX #9aa0a6 → truecolor 154;160;166, on both the ❯ and the border.
  assert.match(raw, /38;2;154;160;166/);
});

test("autocomplete: the shared controller drives a suggestion list in the ink renderer", async () => {
  const h = __harness();
  const provider: AutocompleteProvider = {
    async getSuggestions(lines, _l, col) {
      const before = (lines[0] ?? "").slice(0, col);
      if (!before.startsWith("/")) return null;
      const items = ["/commit", "/clear"].filter((c) => c.startsWith(before) && c !== before).map((c) => ({ value: c, label: c }));
      return items.length ? { items, prefix: before } : null;
    },
  };
  const ctrl = createAutocompleteController({ app: h.app, input: h.app.input, provider, suppressed: () => false });
  h.app.input.setText("/c");
  ctrl.refresh(); // ink's setText doesn't fire onChange; the frontend drives refresh
  await new Promise((r) => setTimeout(r, 0));

  const frame = strip(render(h.element).lastFrame() ?? "");
  assert.match(frame, /\/commit/);
  assert.match(frame, /\/clear/);

  h.feedInput("\x1b[B"); // ↓ → select /clear
  h.feedInput("\t"); // Tab → apply
  assert.equal(h.editor.text, "/clear");
});

test("autocomplete: a kitty key release doesn't double-step the selection", async () => {
  const h = __harness();
  const provider: AutocompleteProvider = {
    async getSuggestions(lines, _l, col) {
      const before = (lines[0] ?? "").slice(0, col);
      if (!before.startsWith("/")) return null;
      const items = ["/alpha", "/bravo", "/charlie"]
        .filter((c) => c.startsWith(before))
        .map((c) => ({ value: c, label: c }));
      return items.length ? { items, prefix: before } : null;
    },
  };
  const ctrl = createAutocompleteController({ app: h.app, input: h.app.input, provider, suppressed: () => false });
  h.app.input.setText("/");
  ctrl.refresh();
  await new Promise((r) => setTimeout(r, 0));

  h.feedInput("\x1b[B");
  h.feedInput("\x1b[1;1:3B");
  h.feedInput("\t");
  assert.equal(h.editor.text, "/bravo");
});
