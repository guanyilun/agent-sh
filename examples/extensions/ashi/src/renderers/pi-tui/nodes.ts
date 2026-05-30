import {
  Container,
  getImageDimensions,
  Image,
  Markdown,
  Spacer,
  Text,
  type Component,
} from "@earendil-works/pi-tui";
import { theme } from "../../theme.js";
import { markdownTheme } from "./theme-adapters.js";
import type {
  ContainerView,
  MarkdownOptions,
  MarkdownView,
  RenderNode,
  RenderNodes,
  TextView,
} from "../../renderer.js";

const asNode = (c: Component): RenderNode => c as unknown as RenderNode;
const asComponent = (n: RenderNode): Component => n as unknown as Component;

class MeasuredText extends Text {
  private fn: ((width: number) => string[]) | null = null;
  private lastWidth = -1;

  setRenderFn(fn: ((width: number) => string[]) | null): void {
    this.fn = fn;
    this.lastWidth = -1;
  }

  override render(width: number): string[] {
    if (this.fn && width !== this.lastWidth) {
      this.lastWidth = width;
      this.setText(this.fn(width).join("\n"));
    }
    return super.render(width);
  }
}

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

// OSC 133 zone brackets let terminals navigate between user prompts.
class ZonedMarkdown extends Markdown {
  override render(width: number): string[] {
    const lines = super.render(width);
    if (lines.length === 0) return lines;
    lines[0] = OSC133_ZONE_START + lines[0];
    lines[lines.length - 1] = lines[lines.length - 1] + OSC133_ZONE_END + OSC133_ZONE_FINAL;
    return lines;
  }
}

class FooterSlot extends Container {
  override render(width: number): string[] {
    return this.children.length === 0 ? [""] : super.render(width);
  }
}

export function footerContainer(): ContainerView {
  const c = new FooterSlot();
  return {
    node: asNode(c),
    addChild: (child) => c.addChild(asComponent(child)),
    removeChild: (child) => c.removeChild(asComponent(child)),
    clear: () => c.clear(),
  };
}

export function createNodes(): RenderNodes {
  return {
    text(opts) {
      const t = new MeasuredText("", opts?.paddingX ?? 0, opts?.paddingY ?? 0);
      const view: TextView = {
        node: asNode(t),
        setText: (s) => t.setText(s),
        setLines: (lines) => t.setText(lines.join("\n")),
        setRenderFn: (fn) => t.setRenderFn(fn),
      };
      return view;
    },

    markdown(opts?: MarkdownOptions) {
      const colorOpts =
        opts?.color || opts?.bgColor
          ? { ...(opts.color ? { color: opts.color } : {}), ...(opts.bgColor ? { bgColor: opts.bgColor } : {}) }
          : undefined;
      const Ctor = opts?.osc133Zones ? ZonedMarkdown : Markdown;
      const md = new Ctor("", opts?.paddingX ?? 0, opts?.paddingY ?? 0, markdownTheme(), colorOpts);
      const view: MarkdownView = {
        node: asNode(md),
        setText: (full) => md.setText(full),
      };
      return view;
    },

    image(png: Buffer): RenderNode | null {
      const base64 = png.toString("base64");
      const dims = getImageDimensions(base64, "image/png");
      if (!dims) return null;
      const img = new Image(
        base64,
        "image/png",
        { fallbackColor: (t) => theme.fg("muted", t) },
        { maxWidthCells: 60, maxHeightCells: 20 },
        dims,
      );
      return asNode(img);
    },

    container(): ContainerView {
      const c = new Container();
      return {
        node: asNode(c),
        addChild: (child) => c.addChild(asComponent(child)),
        removeChild: (child) => c.removeChild(asComponent(child)),
        clear: () => c.clear(),
      };
    },

    spacer(rows: number): RenderNode {
      return asNode(new Spacer(rows));
    },
  };
}
