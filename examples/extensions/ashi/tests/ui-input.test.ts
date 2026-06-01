import test from "node:test";
import assert from "node:assert/strict";
import { createInputPrompt } from "../src/input-prompt.js";
import type { App, InputView, KeyEvent, RenderNode, Renderer } from "../src/renderer.js";

const node = (tag: string): RenderNode => ({ tag }) as unknown as RenderNode;
const esc = (): KeyEvent => ({ matches: (n) => n === "escape", isRelease: () => false, isRepeat: () => false });

function harness() {
  const footer: RenderNode[] = [];
  let onKey: ((k: KeyEvent) => { consume: boolean } | void) | null = null;
  let text = "";
  let focusInput = 0;
  const app = {
    footerSlot: {
      node: node("footer"),
      addChild: (c: RenderNode) => { footer.push(c); },
      removeChild: (c: RenderNode) => { const i = footer.indexOf(c); if (i >= 0) footer.splice(i, 1); },
      clear: () => {},
    },
    onKey: (h: (k: KeyEvent) => { consume: boolean } | void) => { onKey = h; },
    focusInput: () => { focusInput++; },
    requestRender: () => {},
  } as unknown as App;
  const input = {
    node: node("input"),
    getText: () => text,
    setText: (t: string) => { text = t; },
  } as unknown as InputView;
  const renderer = {
    text: () => ({ node: node("text"), setText() {}, setLines() {}, setRenderFn() {} }),
  } as unknown as Renderer;
  let open = false;
  const ip = createInputPrompt(app, renderer, input, { isOpen: () => open, setOpen: (v) => { open = v; } });
  return {
    ip,
    pressEsc: () => onKey?.(esc()),
    footerCount: () => footer.length,
    text: () => text,
    setGuardOpen: (v: boolean) => { open = v; },
    guardOpen: () => open,
    focusInputCount: () => focusInput,
  };
}

test("ui:input resolves with submitted text and cleans up", async () => {
  const h = harness();
  const p = h.ip.prompt({ title: "Name?" });
  assert.equal(h.ip.isActive(), true);
  assert.equal(h.guardOpen(), true, "holds the shared modal guard (blocks pickers)");
  assert.equal(h.footerCount(), 1, "hint mounted");
  assert.equal(h.focusInputCount(), 1, "input focused");

  assert.equal(h.ip.handleSubmit("ada"), true, "submit consumed while active");
  assert.equal(await p, "ada");
  assert.equal(h.ip.isActive(), false);
  assert.equal(h.guardOpen(), false, "releases the guard");
  assert.equal(h.footerCount(), 0, "hint removed");
  assert.equal(h.text(), "", "input cleared");
});

test("ui:input prefill seeds the input", async () => {
  const h = harness();
  const p = h.ip.prompt({ prefill: "draft" });
  assert.equal(h.text(), "draft");
  h.ip.handleSubmit("draft edited");
  assert.equal(await p, "draft edited");
});

test("ui:input Esc cancels with undefined", async () => {
  const h = harness();
  const p = h.ip.prompt();
  assert.deepEqual(h.pressEsc(), { consume: true }, "escape consumed while active");
  assert.equal(await p, undefined);
  assert.equal(h.ip.isActive(), false);
  assert.equal(h.guardOpen(), false, "guard released on cancel");
});

test("ui:input handleSubmit is a no-op when inactive", () => {
  const h = harness();
  assert.equal(h.ip.handleSubmit("ignored"), false);
  assert.equal(h.pressEsc(), undefined, "escape passes through when inactive");
});

test("ui:input is blocked while a picker is open", async () => {
  const h = harness();
  h.setGuardOpen(true);
  assert.equal(await h.ip.prompt(), undefined);
  assert.equal(h.ip.isActive(), false);
});
