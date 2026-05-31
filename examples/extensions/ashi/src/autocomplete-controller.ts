import type {
  App,
  AutocompleteItem,
  AutocompleteProvider,
  InputView,
  KeyEvent,
  SelectView,
} from "./renderer.js";

export interface AutocompleteController {
  /** Re-query suggestions for the current input. Call from the input's onChange. */
  refresh(): void;
}

const VISIBLE_ROWS = 8;

/**
 * Substrate-owned autocomplete: the renderer only draws a SelectView in `belowInput`, so
 * the popup behaves identically in any renderer instead of living inside one editor.
 */
export function createAutocompleteController(opts: {
  app: App;
  input: InputView;
  provider: AutocompleteProvider;
  suppressed: () => boolean;
}): AutocompleteController {
  const { app, input, provider, suppressed } = opts;
  let view: SelectView | null = null;
  let items: AutocompleteItem[] = [];
  let prefix = "";
  let index = 0;
  let reqSeq = 0;
  let applying = false;

  const clear = (): void => {
    if (!view) return;
    app.belowInput.clear();
    view = null;
    items = [];
  };

  const refresh = (): void => {
    if (applying) return;
    if (suppressed()) { clear(); app.requestRender(); return; }
    const lines = input.getText().split("\n");
    const { line, col } = input.getCursor();
    const seq = ++reqSeq;
    void Promise.resolve(provider.getSuggestions(lines, line, col)).then((result) => {
      if (seq !== reqSeq || applying) return;
      if (!result || result.items.length === 0) { clear(); app.requestRender(); return; }
      items = result.items;
      prefix = result.prefix;
      index = Math.max(0, Math.min(index, items.length - 1));
      app.belowInput.clear();
      view = app.createSelectList(
        items.map((it) => ({ value: it.value, label: it.label, description: it.description })),
        { visibleRows: VISIBLE_ROWS },
      );
      view.setSelectedIndex(index);
      app.belowInput.addChild(view.node);
      app.requestRender();
    });
  };

  // Enter applies and closes. Tab applies and, for `@`/path completions, re-queries so
  // you can keep completing deeper — slash commands close (else an exact command would
  // re-match itself and the list would never dismiss). `applying` swallows the onChange
  // that replaceBeforeCursor fires mid-apply.
  const apply = (allowReopen: boolean): void => {
    const chosen = items[index];
    if (!chosen) return;
    const slash = prefix.startsWith("/");
    applying = true;
    input.replaceBeforeCursor(prefix.length, chosen.value);
    clear();
    applying = false;
    if (allowReopen && !slash) refresh();
    app.requestRender();
  };

  app.onKey((key: KeyEvent): { consume: boolean } | void => {
    if (key.isRelease() || key.isRepeat()) return;
    if (!view || items.length === 0) {
      if (key.matches("tab")) { refresh(); return { consume: true }; }
      return;
    }
    if (key.matches("up")) { index = (index - 1 + items.length) % items.length; view.setSelectedIndex(index); app.requestRender(); return { consume: true }; }
    if (key.matches("down")) { index = (index + 1) % items.length; view.setSelectedIndex(index); app.requestRender(); return { consume: true }; }
    if (key.matches("return")) { apply(false); return { consume: true }; }
    if (key.matches("tab")) { apply(true); return { consume: true }; }
    if (key.matches("escape")) { clear(); app.requestRender(); return { consume: true }; }
  });

  return { refresh };
}
