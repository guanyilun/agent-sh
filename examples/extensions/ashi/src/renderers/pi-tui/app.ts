// pi-tui implementation of the App shell.

import {
  Editor,
  isKeyRelease,
  isKeyRepeat,
  Loader,
  matchesKey,
  ProcessTerminal,
  SelectList,
  TUI,
  type Component,
  type SelectItem as PiSelectItem,
} from "@earendil-works/pi-tui";
import { editorTheme, selectListTheme } from "./theme-adapters.js";
import { createNodes } from "./nodes.js";
import type {
  App,
  AutocompleteProvider,
  InputView,
  KeyEvent,
  LoaderView,
  RenderNode,
  SelectItem,
  SelectView,
} from "../../renderer.js";

const asComponent = (n: RenderNode): Component => n as unknown as Component;
const asNode = (c: Component): RenderNode => c as unknown as RenderNode;

// pi-tui's AutocompleteProvider type is structurally identical to ours (lines +
// cursor); we adapt by passing through.
type PiAutocompleteProvider = Parameters<Editor["setAutocompleteProvider"]>[0];

function makeInput(editor: Editor): InputView {
  return {
    node: asNode(editor),
    getText: () => editor.getText(),
    setText: (t) => editor.setText(t),
    onChange: (fn) => { editor.onChange = fn; },
    onSubmit: (fn) => { editor.onSubmit = fn; },
    setAutocompleteProvider: (p: AutocompleteProvider) =>
      editor.setAutocompleteProvider(p as unknown as PiAutocompleteProvider),
    defaultBorderColor: editor.borderColor,
    setBorderColor: (fn) => { editor.borderColor = fn; },
    invalidate: () => editor.invalidate(),
  };
}

function makeSelect(items: SelectItem[], visibleRows: number): SelectView {
  const picker = new SelectList(items as PiSelectItem[], visibleRows, selectListTheme());
  return {
    node: asNode(picker),
    setSelectedIndex: (i) => picker.setSelectedIndex(i),
    getSelectedItem: () => picker.getSelectedItem() as SelectItem | undefined,
    onSelect: (fn) => { picker.onSelect = fn; },
    onCancel: (fn) => { picker.onCancel = fn; },
  };
}

function makeLoader(
  tui: TUI,
  label: string,
  color: (t: string) => string,
  muted: (t: string) => string,
): LoaderView {
  const loader = new Loader(tui, color, muted, label);
  return { node: asNode(loader), stop: () => loader.stop() };
}

export function createApp(): App {
  const nodes = createNodes();
  const terminal = new ProcessTerminal();
  const tui = new TUI(terminal);

  const scrollback = nodes.container();
  const footerSlot = nodes.container();
  const queueSlot = nodes.container();
  const status = nodes.text({ paddingX: 1 });
  const editor = new Editor(tui, editorTheme(), { paddingX: 1 });
  const input = makeInput(editor);

  tui.addChild(asComponent(scrollback.node));
  tui.addChild(asComponent(footerSlot.node));
  tui.addChild(asComponent(queueSlot.node));
  tui.addChild(editor);
  tui.addChild(asComponent(status.node));
  tui.setFocus(editor);

  return {
    scrollback,
    footerSlot,
    queueSlot,
    input,
    status,
    setFocus: (target) => tui.setFocus(asComponent(target)),
    focusInput: () => tui.setFocus(editor),
    requestRender: (force) => tui.requestRender(force),
    start: () => tui.start(),
    stop: () => tui.stop(),
    onKey: (handler) =>
      tui.addInputListener((data) => {
        const key: KeyEvent = {
          matches: (name) => matchesKey(data, name as Parameters<typeof matchesKey>[1]),
          isRelease: () => isKeyRelease(data),
          isRepeat: () => isKeyRepeat(data),
        };
        return handler(key) ?? undefined;
      }),
    createSelectList: (items, opts) => makeSelect(items, opts.visibleRows),
    createLoader: (label, color, muted) => makeLoader(tui, label, color, muted),
  };
}
