import test from "node:test";
import assert from "node:assert/strict";
import { createDialogs } from "../src/dialogs.js";
import type { App, RenderNode, Renderer, SelectItem, SelectView } from "../src/renderer.js";

const node = (tag: string): RenderNode => ({ tag }) as unknown as RenderNode;

function harness() {
  const footer: RenderNode[] = [];
  let onSelect: ((i: SelectItem) => void) | null = null;
  let onCancel: (() => void) | null = null;
  let focusInput = 0;
  const app = {
    footerSlot: {
      node: node("footer"),
      addChild: (c: RenderNode) => { footer.push(c); },
      removeChild: (c: RenderNode) => { const i = footer.indexOf(c); if (i >= 0) footer.splice(i, 1); },
      clear: () => {},
    },
    createSelectList: (_items: SelectItem[]): SelectView => ({
      node: node("picker"),
      setSelectedIndex: () => {},
      getSelectedItem: () => undefined,
      onSelect: (fn: (i: SelectItem) => void) => { onSelect = fn; },
      onCancel: (fn: () => void) => { onCancel = fn; },
    }),
    setFocus: () => {},
    focusInput: () => { focusInput++; },
    requestRender: () => {},
  } as unknown as App;
  const renderer = {
    text: () => ({ node: node("text"), setText() {}, setLines() {}, setRenderFn() {} }),
  } as unknown as Renderer;
  let open = false;
  const dialogs = createDialogs(app, renderer, { isOpen: () => open, setOpen: (v) => { open = v; } });
  return {
    dialogs,
    choose: (item: SelectItem) => onSelect?.(item),
    cancel: () => onCancel?.(),
    footerCount: () => footer.length,
    isOpen: () => open,
    focusInputCount: () => focusInput,
  };
}

test("ui:select resolves with the chosen value and cleans up", async () => {
  const h = harness();
  const p = h.dialogs.select({ items: [{ value: "a", label: "A" }, { value: "b", label: "B" }] });
  assert.equal(h.isOpen(), true, "guard set while open");
  assert.equal(h.footerCount(), 2, "hint + picker mounted");

  h.choose({ value: "b", label: "B" });
  assert.equal(await p, "b");
  assert.equal(h.isOpen(), false, "guard cleared");
  assert.equal(h.footerCount(), 0, "footer cleaned up");
  assert.equal(h.focusInputCount(), 1, "input refocused");
});

test("ui:select cancel resolves undefined", async () => {
  const h = harness();
  const p = h.dialogs.select({ items: [{ value: "a", label: "A" }] });
  h.cancel();
  assert.equal(await p, undefined);
  assert.equal(h.isOpen(), false);
});

test("ui:select returns undefined while a picker is already open", async () => {
  const h = harness();
  const first = h.dialogs.select({ items: [{ value: "a", label: "A" }] });
  const blocked = await h.dialogs.select({ items: [{ value: "x", label: "X" }] });
  assert.equal(blocked, undefined, "second call blocked by the guard");
  h.choose({ value: "a", label: "A" });
  assert.equal(await first, "a");
});

test("ui:select returns undefined for an empty item list", async () => {
  const h = harness();
  assert.equal(await h.dialogs.select({ items: [] }), undefined);
  assert.equal(h.isOpen(), false, "no picker opened");
});

test("ui:confirm maps Yes→true and No→false", async () => {
  const yes = harness();
  const py = yes.dialogs.confirm({ title: "Sure?" });
  yes.choose({ value: "yes", label: "Yes" });
  assert.equal(await py, true);

  const no = harness();
  const pn = no.dialogs.confirm({ title: "Sure?" });
  no.choose({ value: "no", label: "No" });
  assert.equal(await pn, false);
});
