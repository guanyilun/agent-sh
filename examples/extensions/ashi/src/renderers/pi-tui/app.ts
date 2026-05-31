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
import { createNodes, footerContainer } from "./nodes.js";
import type {
  App,
  InputView,
  KeyEvent,
  LoaderView,
  RenderNode,
  SelectItem,
  SelectView,
} from "../../renderer.js";

const asComponent = (n: RenderNode): Component => n as unknown as Component;
const asNode = (c: Component): RenderNode => c as unknown as RenderNode;

function makeInput(editor: Editor): InputView {
  return {
    node: asNode(editor),
    getText: () => editor.getText(),
    setText: (t) => editor.setText(t),
    getCursor: () => editor.getCursor(),
    replaceBeforeCursor: (count, text) => {
      for (let i = 0; i < count; i++) editor.handleInput("\x7f");
      editor.insertTextAtCursor(text);
    },
    onChange: (fn) => { editor.onChange = fn; },
    onSubmit: (fn) => { editor.onSubmit = fn; },
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

class FlushLoader extends Loader {
  override render(width: number): string[] {
    const lines = super.render(width);
    return lines[0] === "" ? lines.slice(1) : lines;
  }
}

function makeLoader(
  tui: TUI,
  label: string,
  color: (t: string) => string,
  muted: (t: string) => string,
): LoaderView {
  const loader = new FlushLoader(tui, color, muted, label);
  return { node: asNode(loader), stop: () => loader.stop() };
}

export function createApp(): App {
  const nodes = createNodes();
  const terminal = new ProcessTerminal();
  const tui = new TUI(terminal);

  const scrollback = nodes.container();
  const footerSlot = footerContainer(
    () => (scrollback.node as unknown as { children: unknown[] }).children.length > 0,
  );
  const queueSlot = nodes.container();
  const status = nodes.text({ paddingX: 1 });
  const belowInput = nodes.container();
  const editor = new Editor(tui, editorTheme(), { paddingX: 1 });
  const input = makeInput(editor);

  tui.addChild(asComponent(scrollback.node));
  tui.addChild(asComponent(footerSlot.node));
  tui.addChild(asComponent(queueSlot.node));
  tui.addChild(editor);
  tui.addChild(asComponent(belowInput.node));
  tui.addChild(asComponent(status.node));
  tui.setFocus(editor);

  return {
    scrollback,
    footerSlot,
    queueSlot,
    input,
    belowInput,
    status,
    setFocus: (target) => tui.setFocus(asComponent(target)),
    focusInput: () => tui.setFocus(editor),
    requestRender: (force) => tui.requestRender(force),
    commitScrollback: () => {},
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
