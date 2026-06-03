import type { App, Renderer, RenderNode } from "./renderer.js";
import { InfoLine } from "./chat/lines.js";

export interface SelectChoice {
  value: string;
  label: string;
  description?: string;
}
export interface SelectOpts {
  title?: string;
  items: SelectChoice[];
  body?: string[] | ((width: number) => string[]);
}
export interface ConfirmOpts {
  title: string;
  body?: string[] | ((width: number) => string[]);
}

export interface DialogGuard {
  isOpen(): boolean;
  setOpen(open: boolean): void;
}

export interface Dialogs {
  select(opts: SelectOpts): Promise<string | undefined>;
  confirm(opts: ConfirmOpts): Promise<boolean>;
}

export function createDialogs(app: App, renderer: Renderer, guard: DialogGuard): Dialogs {
  const select = (opts: SelectOpts): Promise<string | undefined> => {
    if (guard.isOpen() || opts.items.length === 0) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      let bodyNode: RenderNode | null = null;
      if (typeof opts.body === "function") {
        const t = renderer.text();
        t.setRenderFn(opts.body);
        bodyNode = t.node;
      } else if (opts.body && opts.body.length) {
        const t = renderer.text();
        t.setLines(opts.body);
        bodyNode = t.node;
      }
      const hint = new InfoLine(renderer, opts.title ?? "↑↓ move · enter: select · esc: cancel");
      const picker = app.createSelectList(
        opts.items.map((c) => ({ value: c.value, label: c.label, description: c.description })),
        { visibleRows: Math.min(15, Math.max(1, opts.items.length)) },
      );
      let settled = false;
      const close = (result?: string): void => {
        if (settled) return;
        settled = true;
        guard.setOpen(false);
        app.footerSlot.removeChild(picker.node);
        app.footerSlot.removeChild(hint.node);
        if (bodyNode) app.footerSlot.removeChild(bodyNode);
        app.focusInput();
        app.requestRender();
        resolve(result);
      };
      picker.onSelect((item) => close(item.value));
      picker.onCancel(() => close());
      guard.setOpen(true);
      if (bodyNode) app.footerSlot.addChild(bodyNode);
      app.footerSlot.addChild(hint.node);
      app.footerSlot.addChild(picker.node);
      app.setFocus(picker.node);
      app.requestRender();
    });
  };

  const confirm = (opts: ConfirmOpts): Promise<boolean> =>
    select({
      title: opts.title,
      body: opts.body,
      items: [
        { value: "yes", label: "Yes" },
        { value: "no", label: "No" },
      ],
    }).then((v) => v === "yes");

  return { select, confirm };
}
