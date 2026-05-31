import { segmentsToString, type MountArgs, type MountEnv, type RenderModel, type Segment } from "./schema.js";

declare const nodeBrand: unique symbol;
export interface RenderNode {
  readonly [nodeBrand]: true;
}

export interface StyledSink {
  /** Pre-styled lines, painted verbatim (no reflow). */
  setLines(lines: string[]): void;
  setText(text: string): void;
}

export interface TextView extends StyledSink {
  node: RenderNode;
  setRenderFn(fn: ((width: number) => string[]) | null): void;
}

export interface MarkdownOptions {
  color?: (t: string) => string;
  bgColor?: (t: string) => string;
  paddingX?: number;
  paddingY?: number;
  osc133Zones?: boolean;
  /** Primary assistant response — renderers may show a role bullet; others ignore. */
  bullet?: boolean;
}

/** Streaming: ashi pushes the full buffer each update; renderer reflows. */
export interface MarkdownView {
  node: RenderNode;
  setText(full: string): void;
}

export interface ContainerView {
  node: RenderNode;
  addChild(child: RenderNode): void;
  removeChild(child: RenderNode): void;
  clear(): void;
}

export interface RenderNodes {
  text(opts?: { paddingX?: number; paddingY?: number }): TextView;
  markdown(opts?: MarkdownOptions): MarkdownView;
  /** Null when the renderer can't show images. */
  image(png: Buffer): RenderNode | null;
  container(): ContainerView;
  spacer(rows: number): RenderNode;
}

export interface KeyEvent {
  matches(name: string): boolean;
  isRelease(): boolean;
  isRepeat(): boolean;
}

export type KeyHandler = (key: KeyEvent) => { consume: boolean } | void;

export interface AutocompleteItem {
  value: string;
  label: string;
  description?: string;
}

export interface AutocompleteSuggestions {
  items: AutocompleteItem[];
  prefix: string;
}

export interface AutocompleteProvider {
  getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
  ): Promise<AutocompleteSuggestions | null>;
}

export interface InputView {
  node: RenderNode;
  getText(): string;
  setText(text: string): void;
  /** Cursor position — the substrate's autocomplete queries the provider in line/col. */
  getCursor(): { line: number; col: number };
  /** Apply a completion: delete `count` chars before the cursor, insert `text`, cursor after. */
  replaceBeforeCursor(count: number, text: string): void;
  onChange(fn: (text: string) => void): void;
  onSubmit(fn: (text: string) => void): void;
  /** Default border color fn, so callers can restore after a temporary change. */
  readonly defaultBorderColor: (t: string) => string;
  setBorderColor(fn: (t: string) => string): void;
  invalidate(): void;
}

export interface SelectItem {
  value: string;
  label: string;
  description?: string;
}

export interface SelectView {
  node: RenderNode;
  setSelectedIndex(i: number): void;
  getSelectedItem(): SelectItem | undefined;
  onSelect(fn: (item: SelectItem) => void | Promise<void>): void;
  onCancel(fn: () => void): void;
}

export interface LoaderView {
  node: RenderNode;
  stop(): void;
}

export interface App {
  scrollback: ContainerView;
  footerSlot: ContainerView;
  queueSlot: ContainerView;
  input: InputView;
  /** Slot rendered directly beneath the input (e.g. the autocomplete suggestion list). */
  belowInput: ContainerView;
  status: TextView;
  setFocus(target: RenderNode): void;
  focusInput(): void;
  requestRender(force?: boolean): void;
  /** Marks current scrollback as settled; the boundary for renderers that commit finished turns to native scrollback (Ink's <Static>). Others ignore it. */
  commitScrollback?(): void;
  start(): void;
  stop(): void;
  onKey(handler: KeyHandler): void;
  createSelectList(items: SelectItem[], opts: { visibleRows: number }): SelectView;
  createLoader(label: string, color: (t: string) => string, muted: (t: string) => string): LoaderView;
}

export interface ToolCallView {
  node: RenderNode;
  setStatus(opts: { exitCode: number | null; elapsedMs: number; summary?: string }): void;
  toggleExpanded?(): void;
}

export interface ToolResultView {
  node: RenderNode;
  appendChunk(chunk: string): void;
  /** Width-aware diff closure produced by the edit/write tool at finalize. */
  setDiffRenderer(fn: (width: number) => string[]): void;
  finalize(opts: { exitCode: number | null; summary?: string }): void;
  toggleExpanded(): void;
}

export interface ToolGroupChild {
  name: string;
  detail: string;
  status?: { exitCode: number | null; summary?: string };
}

/** A run of same-kind tool calls: substrate owns the state, renderer owns the look. */
export interface ToolGroupModel {
  kind: string;
  icon: string;
  children: ToolGroupChild[];
  hidden: { count: number; ok: boolean } | null;
  expanded: boolean;
  open: boolean;
}

export interface ToolGroupView {
  node: RenderNode;
  update(model: ToolGroupModel): void;
}

/** Default tool-group rendering (`├`/`└` tree): one styled line per row, no indent. */
export function renderToolGroupLines(model: ToolGroupModel): string[] {
  const lines: string[] = [
    segmentsToString([
      { text: model.icon, style: { color: "warning" } },
      " ",
      { text: model.kind, style: { bold: true, color: "toolTitle" } },
    ]),
  ];
  if (model.hidden) {
    const noun = model.hidden.count === 1 ? "earlier call" : "earlier calls";
    lines.push(segmentsToString([
      { text: "├", style: { color: "muted" } }, " ",
      { text: "⋯", style: { color: "muted" } }, " ",
      { text: `${model.hidden.count} ${noun}`, style: { color: "muted" } }, " ",
      { text: model.hidden.ok ? "✓" : "✗", style: { color: model.hidden.ok ? "success" : "error" } },
    ]));
  }
  model.children.forEach((child, idx) => {
    const segs: Segment[] = [{ text: idx === model.children.length - 1 ? "└" : "├", style: { color: "muted" } }, " "];
    if (child.name !== model.kind) segs.push({ text: child.name, style: { bold: true, color: "toolTitle" } }, " ");
    segs.push({ text: child.detail, style: { color: "muted" } }, " ");
    if (!child.status) {
      segs.push(" ", { text: "…", style: { color: "muted" } });
    } else {
      const ok = child.status.exitCode === null || child.status.exitCode === 0;
      segs.push(" ", { text: ok ? "✓" : "✗", style: { color: ok ? "success" : "error" } });
      if (child.status.summary) segs.push(" ", { text: child.status.summary, style: { color: "muted" } });
    }
    lines.push(segmentsToString(segs));
  });
  return lines;
}

export interface RendererCapabilities {
  images: boolean;
  /** When false, assistant/thinking fall back to plain styled text. */
  markdownStreaming: boolean;
  /** True only if the renderer emits its own carriage returns and wants the raw (OPOST-off) terminal; substrate keeps OPOST on otherwise so lone-`\n` renderers don't staircase. */
  rawOutput?: boolean;
  /** Default (omitted) frames the diff in a box; set false to receive bare hunk lines for a self-drawn gutter. */
  diffFrame?: boolean;
}

export interface Renderer extends RenderNodes {
  readonly capabilities: RendererCapabilities;
  /** Visible (ANSI-aware) width of a styled string. */
  measureWidth(text: string): number;
  mountToolCall(model: RenderModel<unknown>, args: MountArgs, env: MountEnv): ToolCallView;
  mountToolResult(model: RenderModel<unknown>, args: MountArgs, env: MountEnv): ToolResultView;
  /** Omitting this opts out of grouping; substrate then renders same-kind calls individually. */
  mountToolGroup?(): ToolGroupView;
  mount(): App;
}
