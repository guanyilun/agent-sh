import type { App, InputView, RenderNode, Renderer } from "./renderer.js";
import { InfoLine } from "./chat/lines.js";

export interface InputOpts {
  title?: string;
  prefill?: string;
}

export interface InputPrompt {
  prompt(opts?: InputOpts): Promise<string | undefined>;
  isActive(): boolean;
  handleSubmit(text: string): boolean;
}

export function createInputPrompt(
  app: App,
  renderer: Renderer,
  input: InputView,
  guard: { isOpen(): boolean; setOpen(open: boolean): void },
): InputPrompt {
  let active: { resolve: (value?: string) => void; hint: RenderNode } | null = null;

  const end = (value?: string): void => {
    if (!active) return;
    const { resolve, hint } = active;
    active = null;
    guard.setOpen(false);
    app.footerSlot.removeChild(hint);
    input.setText("");
    app.requestRender();
    resolve(value);
  };

  app.onKey((key) => {
    if (!active || key.isRelease()) return;
    if (key.matches("escape")) {
      end(undefined);
      return { consume: true };
    }
  });

  return {
    prompt(opts = {}) {
      if (active || guard.isOpen()) return Promise.resolve(undefined);
      return new Promise<string | undefined>((resolve) => {
        const hint = new InfoLine(renderer, opts.title ?? "type · enter: submit · esc: cancel");
        app.footerSlot.addChild(hint.node);
        // Set active before setText: the editor fires onChange synchronously, and the prompt
        // must suppress the normal onChange path (shell-mode derivation / autocomplete).
        active = { resolve, hint: hint.node };
        guard.setOpen(true); // share the pickers' modal flag — a prompt and a picker exclude each other
        input.setText(opts.prefill ?? "");
        app.focusInput();
        app.requestRender();
      });
    },
    isActive: () => active !== null,
    handleSubmit(text) {
      if (!active) return false;
      end(text);
      return true;
    },
  };
}
