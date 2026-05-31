import {
  allocateImageId,
  Container,
  encodeITerm2,
  encodeKitty,
  getCapabilities,
  getCellDimensions,
  getImageDimensions,
  imageFallback,
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

const DEFAULT_IMAGE_SCALE = 1;
const IMAGE_INDENT = 1;

class TerminalImage {
  private readonly base64: string;
  private imageId: number | undefined;
  private cache: { width: number; lines: string[] } | undefined;

  constructor(
    base64: string,
    private readonly dims: { widthPx: number; heightPx: number },
    private readonly indent: number,
    private readonly scale: number,
  ) {
    this.base64 = base64;
  }

  invalidate(): void {
    this.cache = undefined;
  }

  render(width: number): string[] {
    if (this.cache?.width === width) return this.cache.lines;
    const lines = this.build(width);
    this.cache = { width, lines };
    return lines;
  }

  private build(width: number): string[] {
    const pad = " ".repeat(this.indent);
    const caps = getCapabilities();
    if (!caps.images) {
      return [pad + theme.fg("muted", imageFallback("image/png", this.dims))];
    }
    const cell = getCellDimensions();
    const avail = Math.max(1, width - this.indent);
    const want = (this.dims.widthPx * this.scale) / cell.widthPx;
    const cols = Math.max(1, Math.min(avail, Math.round(want)));
    const fit = (cols * cell.widthPx) / this.dims.widthPx;
    const rows = Math.max(1, Math.ceil((this.dims.heightPx * fit) / cell.heightPx));

    if (caps.images === "kitty") {
      if (this.imageId === undefined) this.imageId = allocateImageId();
      // Width only — the terminal preserves aspect. Passing rows too makes
      // Kitty/Ghostty stretch the image to fill the c×r box.
      const seq = encodeKitty(this.base64, { columns: cols, imageId: this.imageId, moveCursor: false });
      const lines = [pad + seq];
      for (let i = 0; i < rows - 1; i++) lines.push("");
      return lines;
    }
    const seq = encodeITerm2(this.base64, { width: cols, height: "auto", preserveAspectRatio: true });
    const lines: string[] = [];
    for (let i = 0; i < rows - 1; i++) lines.push("");
    lines.push((rows > 1 ? `\x1b[${rows - 1}A` : "") + pad + seq);
    return lines;
  }
}

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
    const base = super.render(width);
    if (base.length === 0) return base;
    const lines = base.slice();
    lines[0] = OSC133_ZONE_START + lines[0];
    lines[lines.length - 1] = lines[lines.length - 1] + OSC133_ZONE_END + OSC133_ZONE_FINAL;
    return lines;
  }
}

class FooterSlot extends Container {
  constructor(private readonly hasContentAbove: () => boolean) {
    super();
  }
  override render(width: number): string[] {
    if (this.children.length > 0) return super.render(width);
    return this.hasContentAbove() ? [""] : [];
  }
}

export function footerContainer(hasContentAbove: () => boolean): ContainerView {
  const c = new FooterSlot(hasContentAbove);
  return {
    node: asNode(c),
    addChild: (child) => c.addChild(asComponent(child)),
    removeChild: (child) => c.removeChild(asComponent(child)),
    clear: () => c.clear(),
  };
}

export function createNodes(opts: { imageScale?: number } = {}): RenderNodes {
  const imageScale = opts.imageScale ?? DEFAULT_IMAGE_SCALE;
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
      return asNode(new TerminalImage(base64, dims, IMAGE_INDENT, imageScale));
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
