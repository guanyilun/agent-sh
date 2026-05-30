import test from "node:test";
import assert from "node:assert/strict";
import { createAutocompleteController } from "../src/autocomplete-controller.js";
import { createPiTuiRenderer } from "../src/renderers/pi-tui/index.js";
import type { App, AutocompleteProvider, InputView, KeyEvent, RenderNode, SelectItem } from "../src/renderer.js";

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

const COMMANDS = ["/commit", "/clear", "/clean"];
const provider: AutocompleteProvider = {
  async getSuggestions(lines, _line, col) {
    const before = (lines[0] ?? "").slice(0, col);
    if (!before.startsWith("/")) return null;
    const items = COMMANDS.filter((c) => c.startsWith(before) && c !== before).map((c) => ({ value: c, label: c }));
    return items.length ? { items, prefix: before } : null;
  },
};

const key = (name: string): KeyEvent => ({ matches: (n) => n === name, isRelease: () => false, isRepeat: () => false });

function harness(prov: AutocompleteProvider = provider) {
  let buf = "";
  let children: RenderNode[] = [];
  let view: { items: SelectItem[]; index: number } | null = null;
  let onKey: ((k: KeyEvent) => { consume: boolean } | void) | null = null;

  const input = {
    getText: () => buf,
    getCursor: () => ({ line: 0, col: buf.length }),
    replaceBeforeCursor: (count: number, text: string) => { buf = buf.slice(0, buf.length - count) + text; },
  } as unknown as InputView;

  const app = {
    belowInput: { node: {} as RenderNode, addChild: (c: RenderNode) => children.push(c), removeChild: () => {}, clear: () => { children = []; } },
    createSelectList: (items: SelectItem[]) => {
      view = { items, index: 0 };
      return { node: {} as RenderNode, setSelectedIndex: (i: number) => { view!.index = i; }, getSelectedItem: () => view!.items[view!.index], onSelect: () => {}, onCancel: () => {} };
    },
    requestRender: () => {},
    onKey: (h: (k: KeyEvent) => { consume: boolean } | void) => { onKey = h; },
  } as unknown as App;

  const ctrl = createAutocompleteController({ app, input, provider: prov, suppressed: () => false });
  return {
    type: (s: string) => { buf += s; ctrl.refresh(); },
    setBuf: (s: string) => { buf = s; },
    press: (name: string) => onKey?.(key(name)),
    buf: () => buf,
    items: () => (children.length ? view!.items.map((i) => i.value) : []),
    index: () => view?.index ?? -1,
  };
}

test("typing / shows matching commands, ↑/↓ navigate (wrapping), Esc dismisses", async () => {
  const h = harness();
  h.type("/c");
  await tick();
  assert.deepEqual(h.items(), ["/commit", "/clear", "/clean"]);
  assert.equal(h.index(), 0);
  h.press("down");
  h.press("down");
  assert.equal(h.index(), 2);
  h.press("down");
  assert.equal(h.index(), 0); // wraps
  h.press("escape");
  assert.deepEqual(h.items(), []);
});

test("Tab applies the selected completion to the buffer", async () => {
  const h = harness();
  h.type("/cl");
  await tick();
  assert.deepEqual(h.items(), ["/clear", "/clean"]);
  h.press("down"); // /clean
  const consumed = h.press("tab");
  assert.deepEqual(consumed, { consume: true });
  assert.equal(h.buf(), "/clean");
});

test("applying a slash command closes the list — no reopen loop (e.g. /fork)", async () => {
  // A provider that keeps returning /fork even once it's fully typed (as the real
  // command bus does) — Enter must still close so the next Enter can submit.
  const sticky: AutocompleteProvider = {
    async getSuggestions(lines, _line, col) {
      const before = (lines[0] ?? "").slice(0, col);
      return before.startsWith("/f") ? { items: [{ value: "/fork", label: "/fork" }], prefix: before } : null;
    },
  };
  const h = harness(sticky);
  h.type("/fork");
  await tick();
  assert.deepEqual(h.items(), ["/fork"]);
  h.press("return"); // accept + close
  assert.deepEqual(h.items(), []); // stays closed even though /fork still matches
});

test("Tab with nothing showing triggers a query", async () => {
  const h = harness();
  h.setBuf("/c"); // buffer set without firing onChange/refresh
  const consumed = h.press("tab");
  assert.deepEqual(consumed, { consume: true });
  await tick();
  assert.deepEqual(h.items(), ["/commit", "/clear", "/clean"]);
});

test("the suggestion list renders in belowInput on the real pi-tui renderer", async () => {
  const app = createPiTuiRenderer().mount();
  const ctrl = createAutocompleteController({ app, input: app.input, provider, suppressed: () => false });
  app.input.setText("/c");
  ctrl.refresh(); // the frontend drives refresh from onChange; do it directly here
  await tick();
  const node = app.belowInput.node as unknown as { render(w: number): string[] };
  const lines = node.render(80).map(strip);
  assert.ok(lines.some((l) => l.includes("/commit")), `expected /commit in belowInput, got: ${lines.join("|")}`);
});

test("pi-tui replaceBeforeCursor deletes the prefix and inserts, cursor after", () => {
  const app = createPiTuiRenderer().mount();
  app.input.setText("/c");
  app.input.replaceBeforeCursor(2, "/clear");
  assert.equal(app.input.getText(), "/clear");
  assert.deepEqual(app.input.getCursor(), { line: 0, col: 6 });
});
